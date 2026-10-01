package app.murmur.android.cloud

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.VisibleForTesting
import app.murmur.android.history.HistoryStore
import app.murmur.android.settings.SettingsStore
import com.clerk.api.Clerk
import dev.convex.android.ConvexClientWithAuth
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** The step of bringing the cloud up that failed. */
enum class CloudStage {
    /** `Clerk.initialize` threw. */
    CLERK,
    /** The Convex client (Rust behind UniFFI, loaded through JNA) could not be constructed. */
    CONVEX,
    /** The sync engine could not start. */
    SYNC,
    /** The last launch died while the cloud was coming up, so this launch waits before trying. */
    PREVIOUS_LAUNCH
}

/** Where the cloud stands for this run of the app. */
sealed class CloudBoot {
    /** A local-only build: nothing to bring up. */
    data object Off : CloudBoot()

    /** Clerk and the Convex client are up. Clerk may still be fetching its state (`Clerk.isInitialized`). */
    data class Ready(val config: CloudConfig) : CloudBoot()

    /**
     * A step failed: the app runs in local mode, and the Account screen says why and offers a
     * retry. [retryInMs] is set when the bootstrap will try again by itself after that long.
     */
    data class Failed(val config: CloudConfig, val stage: CloudStage, val error: Throwable?, val retryInMs: Long? = null) : CloudBoot()

    /** Clerk and the sync engine may be touched: their classes loaded and their initialisation returned. */
    val usable: Boolean get() = this is Ready
}

/**
 * Brings the cloud up (Clerk, the Convex client, the sync engine) so that nothing on that path can
 * take the app down: every step runs behind a catch of [Throwable] (an `UnsatisfiedLinkError` from
 * JNA, a `NoClassDefFoundError`, an `ExceptionInInitializerError` from a static initialiser, any
 * exception the SDKs throw), a failure is logged and published as [CloudBoot.Failed], and the app
 * carries on in local mode: the user's own provider, the local settings and history all work.
 *
 * A [CloudBootGuard] covers what a catch cannot: a launch that dies while the cloud is coming up
 * (a native crash, an error thrown on a later frame) is noticed on the next launch, which then
 * holds the cloud back for a while before trying again ([CloudBootGuard.retryDelayMs]: half a
 * minute after one such death, longer after each one in a row), so a broken cloud path can never
 * brick the app, and a process that was merely killed while connecting (the system reclaiming it,
 * an update installing) costs at most that wait rather than the cloud for the life of the process.
 *
 * The coroutine scope handed to the Convex client and the sync engine carries an exception handler
 * too: an uncaught exception in cloud work is logged and shown as a sync error instead of ending
 * the process, which is what an unhandled exception in a coroutine does on Android.
 */
object CloudBootstrap {
    private const val TAG = "MurmurCloud"

    /** The cloud path has this long after starting to prove it does not take the app down. */
    const val GUARD_WINDOW_MS = 10_000L

    /** Each step of the start-up, replaceable by a test to make it throw. */
    class Steps(
        val initClerk: (Context, CloudConfig) -> Unit = { context, config ->
            Clerk.initialize(context, publishableKey = config.clerkPublishableKey)
        },
        val createClient: (CloudConfig, CoroutineScope) -> ConvexClientWithAuth<ClerkCredentials> = { config, scope ->
            ConvexClientWithAuth(config.convexUrl, ClerkAuthProvider(), scope)
        },
        val startSync: (Context, CloudConfig, ConvexClientWithAuth<ClerkCredentials>, CoroutineScope) -> CloudSync =
            { context, config, client, scope ->
                CloudSync.init(context, config, SettingsStore.get(context), HistoryStore.get(context), client, scope)
            }
    )

    private val _state = MutableStateFlow<CloudBoot>(CloudBoot.Off)

    /** The current outcome; the Account screen and the gate follow it across retries. */
    val state: StateFlow<CloudBoot> = _state

    private var steps = Steps()
    private var guard: CloudBootGuard? = null
    private var guardRelease: Runnable? = null
    private var scheduledRetry: Runnable? = null
    private var appContext: Context? = null

    /** The engine the last successful start brought up; uncaught cloud work is reported to it. */
    @Volatile private var engine: CloudSync? = null

    /**
     * Brings the cloud up for [config], or notes why it could not. Never throws. Call once from
     * `Application.onCreate`; [retry] runs it again from the Account screen.
     */
    fun start(
        context: Context,
        config: CloudConfig,
        steps: Steps = Steps(),
        guard: CloudBootGuard = CloudBootGuard(context)
    ): CloudBoot {
        this.steps = steps
        this.guard = guard
        this.appContext = context.applicationContext
        if (!config.enabled) return publish(CloudBoot.Off)
        if (guard.tripped()) {
            val trips = guard.recordTrip()
            guard.disarm()
            val delay = CloudBootGuard.retryDelayMs(trips)
            Log.w(TAG, "the last launch died while the cloud was coming up ($trips in a row); trying again in ${delay / 1000}s")
            CloudDiagnostics.guard("tripped by the previous launch ($trips in a row); cloud held back ${delay / 1000}s")
            scheduleRetry(delay)
            return publish(CloudBoot.Failed(config, CloudStage.PREVIOUS_LAUNCH, null, retryInMs = delay))
        }
        return bringUp(context, config)
    }

    /**
     * Tries again after a failure, from the Account screen or the timer. A [CloudBoot.Ready] cloud
     * whose Clerk could not fetch its state asks Clerk to try again instead.
     */
    fun retry(context: Context): CloudBoot {
        cancelScheduledRetry()
        val config = when (val current = _state.value) {
            CloudBoot.Off -> return current
            is CloudBoot.Ready -> {
                runCatching { Clerk.reinitialize() }.onFailure { Log.w(TAG, "Clerk could not be asked to reinitialise", it) }
                return current
            }
            is CloudBoot.Failed -> current.config
        }
        return bringUp(context, config)
    }

    /** The app's UI is going away normally (`Activity.onStop`); a death after this is not a start-up crash. */
    fun onUiStopped() {
        releaseGuard(proved = false)
    }

    private fun bringUp(context: Context, config: CloudConfig): CloudBoot {
        val app = context.applicationContext
        guard?.arm()
        CloudDiagnostics.guard("armed", log = false)
        val scope = CoroutineScope(
            SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, e ->
                Log.e(TAG, "cloud work failed; the app carries on", e)
                CloudDiagnostics.event("uncaught cloud work: ${describe(e)}")
                (engine ?: CloudSync.get())?.reportFailure(e)
            }
        )
        var stage = CloudStage.CLERK
        val boot: CloudBoot = try {
            steps.initClerk(app, config)
            stage = CloudStage.CONVEX
            val client = steps.createClient(config, scope)
            stage = CloudStage.SYNC
            engine = steps.startSync(app, config, client, scope)
            CloudBoot.Ready(config)
        } catch (e: Throwable) {
            Log.e(TAG, "cloud start-up failed at $stage; running in local mode", e)
            CloudBoot.Failed(config, stage, e)
        }
        if (boot is CloudBoot.Ready) {
            // The cloud is up; if the app is still alive after the window, the launch was fine.
            val release = Runnable { releaseGuard(proved = true) }
            guardRelease = release
            Handler(Looper.getMainLooper()).postDelayed(release, GUARD_WINDOW_MS)
            CloudDiagnostics.boot("ready (${config.accountMode.name.lowercase()}, ${config.convexUrl})")
        } else {
            releaseGuard(proved = false)
            CloudDiagnostics.boot("failed at ${stage.name.lowercase()}: ${(boot as CloudBoot.Failed).error?.let(::describe) ?: "unknown"}")
        }
        return publish(boot)
    }

    private fun scheduleRetry(delayMs: Long) {
        cancelScheduledRetry()
        val retry = Runnable {
            scheduledRetry = null
            val context = appContext ?: return@Runnable
            if (_state.value is CloudBoot.Failed) {
                CloudDiagnostics.event("boot guard wait over; bringing the cloud up")
                retry(context)
            }
        }
        scheduledRetry = retry
        Handler(Looper.getMainLooper()).postDelayed(retry, delayMs)
    }

    private fun cancelScheduledRetry() {
        scheduledRetry?.let { Handler(Looper.getMainLooper()).removeCallbacks(it) }
        scheduledRetry = null
    }

    /** Stands the guard down: [proved] when the cloud stayed up for the window, which also forgets earlier trips. */
    private fun releaseGuard(proved: Boolean) {
        guardRelease?.let { Handler(Looper.getMainLooper()).removeCallbacks(it) }
        guardRelease = null
        guard?.disarm()
        if (proved) {
            guard?.clearTrips()
            CloudDiagnostics.guard("released: the cloud stayed up for ${GUARD_WINDOW_MS / 1000}s")
        } else {
            CloudDiagnostics.guard("released", log = false)
        }
    }

    private fun publish(boot: CloudBoot): CloudBoot {
        _state.value = boot
        return boot
    }

    /** One line for a screen: the error's kind and message, without a stack. */
    fun describe(error: Throwable): String {
        val kind = error::class.java.simpleName.ifEmpty { error::class.java.name }
        val message = error.message?.lineSequence()?.firstOrNull()?.trim().orEmpty()
        val text = if (message.isEmpty()) kind else "$kind: $message"
        return if (text.length > 200) text.take(199) + "…" else text
    }

    /** What the Account screen says about a [CloudBoot.Failed]. */
    fun explain(failed: CloudBoot.Failed): String = when (failed.stage) {
        CloudStage.PREVIOUS_LAUNCH ->
            "Murmur closed unexpectedly while connecting last time, so it started without the account service." +
                (failed.retryInMs?.let { " It tries again on its own in ${describeDelay(it)}." }.orEmpty())
        CloudStage.CLERK -> "The sign-in service could not be started" + failed.error?.let { ": ${describe(it)}" }.orEmpty()
        CloudStage.CONVEX -> "The sync client could not be started" + failed.error?.let { ": ${describe(it)}" }.orEmpty()
        CloudStage.SYNC -> "The sync engine could not be started" + failed.error?.let { ": ${describe(it)}" }.orEmpty()
    }

    private fun describeDelay(ms: Long): String {
        val s = ms / 1000
        return when {
            s < 60 -> "$s seconds"
            s < 3600 -> "${s / 60} ${if (s / 60 == 1L) "minute" else "minutes"}"
            else -> "${s / 3600} ${if (s / 3600 == 1L) "hour" else "hours"}"
        }
    }

    /** Back to nothing started, for tests that run several launches in one process. */
    @VisibleForTesting
    fun reset() {
        cancelScheduledRetry()
        releaseGuard(proved = false)
        guard = null
        engine = null
        appContext = null
        steps = Steps()
        _state.value = CloudBoot.Off
    }
}

/**
 * Notices a launch that died while the cloud was coming up, so the next one holds the cloud back.
 *
 * A flag in its own SharedPreferences file, written to disk before the cloud starts and cleared
 * once the cloud has been up for [CloudBootstrap.GUARD_WINDOW_MS] or the UI has gone away
 * normally. A process that dies in between leaves the flag set; the next launch reads it, counts
 * one more death in a row, and waits [retryDelayMs] before bringing the cloud up. A cloud that
 * then stays up for the window clears the count.
 */
class CloudBootGuard(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** The last launch armed the guard and never disarmed it. */
    fun tripped(): Boolean = prefs.getBoolean(KEY_PENDING, false)

    /** How many launches in a row died while the cloud was coming up. */
    val trips: Int get() = prefs.getInt(KEY_TRIPS, 0)

    fun arm() {
        prefs.edit().putBoolean(KEY_PENDING, true).commit()
    }

    fun disarm() {
        prefs.edit().putBoolean(KEY_PENDING, false).commit()
    }

    /** One more launch died while connecting; returns how many in a row that makes. */
    fun recordTrip(): Int {
        val next = trips + 1
        prefs.edit().putInt(KEY_TRIPS, next).commit()
        return next
    }

    /** The cloud stayed up for the window: earlier deaths were not its doing after all. */
    fun clearTrips() {
        if (trips != 0) prefs.edit().putInt(KEY_TRIPS, 0).commit()
    }

    companion object {
        const val FILE = "murmur_cloud_boot"
        const val KEY_PENDING = "pending"
        const val KEY_TRIPS = "trips"

        /** After the first death in a row the cloud waits this long before trying again. */
        const val FIRST_RETRY_MS = 30_000L

        /** Never wait longer than this between tries, however many deaths in a row. */
        const val MAX_RETRY_MS = 3_600_000L

        /** How long to hold the cloud back after [trips] deaths in a row: 30 s, 2 min, 8 min, 32 min, then an hour. */
        fun retryDelayMs(trips: Int): Long {
            var delay = FIRST_RETRY_MS
            repeat((trips - 1).coerceIn(0, 10)) { delay = (delay * 4).coerceAtMost(MAX_RETRY_MS) }
            return delay.coerceAtMost(MAX_RETRY_MS)
        }
    }
}
