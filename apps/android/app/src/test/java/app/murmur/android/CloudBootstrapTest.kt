package app.murmur.android

import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import app.murmur.android.cloud.ClerkAuthProvider
import app.murmur.android.cloud.ClerkCredentials
import app.murmur.android.cloud.ClerkTokens
import app.murmur.android.cloud.CloudBoot
import app.murmur.android.cloud.CloudBootGuard
import app.murmur.android.cloud.CloudBootstrap
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudStage
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.SyncPhase
import app.murmur.android.history.HistoryStore
import app.murmur.android.settings.SettingsStore
import dev.convex.android.AuthProvider
import dev.convex.android.ConvexClientWithAuth
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The cloud start-up can never take the app down: each step is made to throw the kinds of error a
 * broken native library, a missing class or a failing static initialiser produce, and the app
 * comes up in local mode with the failure on record. The boot guard catches what no catch can, a
 * launch that dies while the cloud is coming up.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CloudBootstrapTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val config = CloudConfig.resolve("https://a.convex.cloud", "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k", "optional")

    /** A Convex client on the fake FFI, so the sync engine can start without the native library. */
    private class NoClerk : AuthProvider<ClerkCredentials> {
        override suspend fun login(context: Context, onIdToken: (String?) -> Unit) = Result.failure<ClerkCredentials>(IllegalStateException("no"))
        override suspend fun logout(context: Context): Result<Void?> = Result.success(null)
        override fun extractIdToken(authResult: ClerkCredentials): String = authResult.token
    }

    private fun fakeClient(scope: CoroutineScope): ConvexClientWithAuth<ClerkCredentials> =
        ConvexClientWithAuth(config.convexUrl, NoClerk(), scope, FakeConvex().factory())

    /** The steps with every real SDK call replaced: Clerk is never touched, the engine runs on a fake Convex. */
    private fun steps(
        initClerk: (Context, CloudConfig) -> Unit = { _, _ -> },
        createClient: (CloudConfig, CoroutineScope) -> ConvexClientWithAuth<ClerkCredentials> = { _, scope -> fakeClient(scope) },
        startSync: (Context, CloudConfig, ConvexClientWithAuth<ClerkCredentials>, CoroutineScope) -> CloudSync =
            { ctx, cfg, client, scope ->
                CloudSync(ctx, cfg, SettingsStore.get(ctx), HistoryStore.get(ctx), MutableStateFlow(null), scope, client).also { it.start() }
            }
    ) = CloudBootstrap.Steps(initClerk, createClient, startSync)

    private fun guard() = CloudBootGuard(context)

    @Before
    fun fresh() {
        CloudBootstrap.reset()
        guard().disarm()
    }

    @After
    fun tearDown() {
        CloudBootstrap.reset()
        guard().disarm()
    }

    @Test
    fun localBuildStartsNothing() {
        var touched = false
        val boot = CloudBootstrap.start(context, CloudConfig.OFF, steps(initClerk = { _, _ -> touched = true }), guard())
        assertSame(CloudBoot.Off, boot)
        assertFalse(touched)
        assertFalse(guard().tripped())
    }

    @Test
    fun everyStepUpStartsTheCloud() {
        val boot = CloudBootstrap.start(context, config, steps(), guard())
        assertEquals(CloudBoot.Ready(config), boot)
        assertTrue(boot.usable)
        assertEquals(boot, CloudBootstrap.state.value)
        // The guard is armed until the cloud has been up for the window, then stands down.
        assertTrue(guard().tripped())
        shadowOf(Looper.getMainLooper()).idleFor(CloudBootstrap.GUARD_WINDOW_MS + 1, TimeUnit.MILLISECONDS)
        assertFalse(guard().tripped())
    }

    @Test
    fun clerkThrowingAnErrorLeavesTheAppInLocalMode() {
        val boot = CloudBootstrap.start(
            context, config,
            steps(initClerk = { _, _ -> throw ExceptionInInitializerError(IllegalStateException("Clerk static init")) }),
            guard()
        )
        val failed = boot as CloudBoot.Failed
        assertEquals(CloudStage.CLERK, failed.stage)
        assertTrue(failed.error is ExceptionInInitializerError)
        assertFalse(boot.usable)
        assertNull("no engine runs after a failed start", CloudSync.get())
        assertFalse("a failure that was caught is not a crash", guard().tripped())
        assertTrue(CloudBootstrap.explain(failed).startsWith("The sign-in service could not be started"))
    }

    @Test
    fun convexClientThrowingUnsatisfiedLinkErrorLeavesTheAppInLocalMode() {
        val boot = CloudBootstrap.start(
            context, config,
            steps(createClient = { _, _ -> throw UnsatisfiedLinkError("Native library (com/sun/jna/android-aarch64/libjnidispatch.so) not found") }),
            guard()
        )
        val failed = boot as CloudBoot.Failed
        assertEquals(CloudStage.CONVEX, failed.stage)
        assertTrue(failed.error is UnsatisfiedLinkError)
        assertNull(CloudSync.get())
        assertEquals(
            "The sync client could not be started: UnsatisfiedLinkError: Native library (com/sun/jna/android-aarch64/libjnidispatch.so) not found",
            CloudBootstrap.explain(failed)
        )
    }

    @Test
    fun theRealConvexClientCannotLoadOnTheJvmAndTheAppStillStarts() {
        // The AAR ships Android native libraries only, so on the JVM the real client fails to load;
        // exactly what a device with a broken JNA would do. Clerk is left out of this one.
        val boot = CloudBootstrap.start(
            context, config,
            steps(createClient = { cfg, scope -> ConvexClientWithAuth(cfg.convexUrl, ClerkAuthProvider(), scope) }),
            guard()
        )
        val failed = boot as CloudBoot.Failed
        assertEquals(CloudStage.CONVEX, failed.stage)
        assertNotNull(failed.error)
        assertTrue(
            "expected a linkage error, got ${failed.error}",
            failed.error is UnsatisfiedLinkError || failed.error is NoClassDefFoundError || failed.error is ExceptionInInitializerError
        )
    }

    @Test
    fun syncEngineThrowingNoClassDefFoundErrorLeavesTheAppInLocalMode() {
        val boot = CloudBootstrap.start(
            context, config,
            steps(startSync = { _, _, _, _ -> throw NoClassDefFoundError("kotlinx/serialization/json/Json") }),
            guard()
        )
        val failed = boot as CloudBoot.Failed
        assertEquals(CloudStage.SYNC, failed.stage)
        assertTrue(failed.error is NoClassDefFoundError)
        assertFalse(guard().tripped())
    }

    @Test
    fun aLaunchThatDiedWhileConnectingSkipsTheCloudOnceThenRetries() {
        // The previous process armed the guard and never got to disarm it.
        guard().arm()
        var clerkStarts = 0
        val steps = steps(initClerk = { _, _ -> clerkStarts++ })
        val boot = CloudBootstrap.start(context, config, steps, guard())
        val failed = boot as CloudBoot.Failed
        assertEquals(CloudStage.PREVIOUS_LAUNCH, failed.stage)
        assertNull(failed.error)
        assertEquals("the cloud is not brought up on the launch after a crash", 0, clerkStarts)
        assertFalse("the next launch tries again", guard().tripped())
        assertEquals(
            "Murmur closed unexpectedly while connecting last time, so it started without the account service.",
            CloudBootstrap.explain(failed)
        )
        // Trying again from the Account screen brings the cloud up.
        val retried = CloudBootstrap.retry(context)
        assertEquals(CloudBoot.Ready(config), retried)
        assertEquals(1, clerkStarts)
        assertEquals(retried, CloudBootstrap.state.value)
    }

    @Test
    fun leavingTheAppNormallyStandsTheGuardDown() {
        CloudBootstrap.start(context, config, steps(), guard())
        assertTrue(guard().tripped())
        CloudBootstrap.onUiStopped()
        assertFalse(guard().tripped())
    }

    @Test
    fun uncaughtCloudWorkBecomesASyncIssueNotACrash() {
        var engine: CloudSync? = null
        var scopeUsed: CoroutineScope? = null
        CloudBootstrap.start(
            context, config,
            steps(startSync = { ctx, cfg, client, scope ->
                scopeUsed = scope
                CloudSync(ctx, cfg, SettingsStore.get(ctx), HistoryStore.get(ctx), MutableStateFlow(null), scope, client)
                    .also { it.start(); engine = it }
            }),
            guard()
        )
        // Something on the engine's scope blows up outside every catch: the scope's handler turns it
        // into a sync issue on the engine (on Android an unhandled one would end the process).
        val job = scopeUsed!!.launch { throw IllegalStateException("subscription decoder exploded") }
        runBlocking { job.join() }
        assertEquals("IllegalStateException: subscription decoder exploded", engine!!.status.value.error)
        assertEquals(SyncPhase.SIGNED_OUT, engine!!.status.value.phase)
    }

    @Test
    fun sessionTokenIsNullWithoutACloud() = runBlocking {
        // Nothing started: Clerk is never touched and nobody waits.
        assertNull(ClerkTokens.sessionToken(skipCache = false, timeoutMs = 100))
    }

    @Test
    fun describeIsOneLine() {
        assertEquals("IllegalStateException: first line", CloudBootstrap.describe(IllegalStateException("first line\nsecond line")))
        assertEquals("UnsatisfiedLinkError", CloudBootstrap.describe(UnsatisfiedLinkError()))
        assertEquals(200, CloudBootstrap.describe(RuntimeException("x".repeat(400))).length)
    }
}
