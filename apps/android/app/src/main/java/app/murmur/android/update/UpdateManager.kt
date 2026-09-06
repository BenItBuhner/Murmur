package app.murmur.android.update

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import app.murmur.android.BuildConfig
import app.murmur.android.R
import app.murmur.android.settings.SettingsStore
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

private const val TAG = "MurmurUpdate"

class UpdateException(message: String) : Exception(message)

/**
 * Android counterpart of apps/desktop/src/main/update/service.ts: reads the repository's GitHub
 * Releases, downloads `Murmur-<version>-android.apk`, verifies it against SHA256SUMS.txt and hands
 * it to the system package installer.
 *
 * Android never installs silently for a plain app... except when the app updates itself: with
 * UPDATE_PACKAGES_WITHOUT_USER_ACTION and a PackageInstaller session, Android 12+ lets an app
 * replace itself without a dialog once it has been the installer of its current version. The very
 * first in-app update therefore shows the system confirmation; the ones after it are unattended.
 */
class UpdateManager private constructor(private val app: Context, private val settings: SettingsStore) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val prefs = app.getSharedPreferences("murmur_updater", Context.MODE_PRIVATE)
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .build()
    private val checkMutex = Mutex()
    private var downloadJob: Job? = null

    private val repo = BuildConfig.UPDATE_REPO
    private val apiBase = "https://api.github.com"
    private val downloadOrigin = "https://github.com"

    private val _state = MutableStateFlow(
        UpdateState(currentVersion = BuildConfig.VERSION_NAME, lastCheckedAt = prefs.getLong(KEY_LAST_CHECKED, 0L))
    )
    val state: StateFlow<UpdateState> = _state

    /** Set by MainActivity so a pending confirmation can be shown directly instead of via notification. */
    @Volatile
    var foreground: Boolean = false

    /** Whether a restart right now would interrupt the user (a dictation in flight). */
    @Volatile
    var isIdle: () -> Boolean = { true }

    init {
        val pendingVersion = prefs.getString(KEY_PENDING_VERSION, null)
        if (pendingVersion != null) {
            if (pendingVersion == BuildConfig.VERSION_NAME) {
                val from = prefs.getString(KEY_PENDING_FROM, null)
                Log.i(TAG, "relaunched after updating from $from to $pendingVersion")
                _state.update { it.copy(updatedFrom = from) }
            } else {
                Log.w(TAG, "update to $pendingVersion did not complete")
            }
            clearPending()
        }
        cleanDownloads()
        refreshInstallPermission()
    }

    val releasesPageUrl: String get() = "$downloadOrigin/$repo/releases"

    // ---- checking -------------------------------------------------------------------------------

    /** Look for a newer release. Manual checks ignore the skipped version and always report. */
    suspend fun check(manual: Boolean): UpdateState = checkMutex.withLock { doCheck(manual) }

    fun checkAsync(manual: Boolean) {
        scope.launch { check(manual) }
    }

    /** Called when the settings screen is shown: refresh permissions and check when it is time. */
    fun onAppVisible() {
        refreshInstallPermission()
        val st = _state.value
        if (settings.get().updateAutoCheck &&
            st.phase != UpdatePhase.DOWNLOADING && st.phase != UpdatePhase.INSTALLING &&
            System.currentTimeMillis() - st.lastCheckedAt > FOREGROUND_INTERVAL_MS
        ) {
            checkAsync(manual = false)
        }
        // Coming back from "Allow from this source": finish what the user started.
        if (!st.needsInstallPermission && st.phase == UpdatePhase.READY && st.canInstall && awaitingPermission) {
            awaitingPermission = false
            install()
        }
    }

    private suspend fun doCheck(manual: Boolean): UpdateState = withContext(Dispatchers.IO) {
        val prefsNow = settings.get()
        val prev = _state.value
        if (prev.phase == UpdatePhase.INSTALLING) return@withContext prev
        _state.update { it.copy(phase = UpdatePhase.CHECKING, error = null) }
        try {
            val releases = fetchReleases()
            val now = System.currentTimeMillis()
            prefs.edit().putLong(KEY_LAST_CHECKED, now).apply()
            val chosen = UpdateSelection.selectRelease(
                releases,
                BuildConfig.VERSION_NAME,
                prefsNow.updateIncludePrereleases,
                if (manual) null else prefsNow.updateSkippedVersion
            )
            if (chosen == null) {
                discardDownload()
                _state.update {
                    it.copy(
                        phase = UpdatePhase.UP_TO_DATE, release = null, downloadedPath = null,
                        progress = 0f, downloadedBytes = 0L, lastCheckedAt = now
                    )
                }
                return@withContext _state.value
            }
            val apkName = UpdateSelection.apkAssetName(chosen.tag_name)
            var apk = chosen.assets.firstOrNull { it.name == apkName }
            if (apk != null && !UpdateSelection.isTrustedAssetUrl(apk.browser_download_url, downloadOrigin)) {
                Log.w(TAG, "ignoring APK served from an unexpected origin: ${apk.browser_download_url}")
                apk = null
            }
            val sha = if (apk != null) fetchChecksum(chosen, apkName) else null
            val info = UpdateSelection.describe(chosen, apk, sha)
            Log.i(TAG, "update available: ${info.version} (${apk?.name ?: "no APK"}${if (sha != null) ", checksum found" else ", no checksum"})")

            val sameDownload = prev.phase == UpdatePhase.READY && prev.downloadedPath != null &&
                File(prev.downloadedPath).exists() && prev.release?.version == info.version
            if (sameDownload) {
                _state.update { it.copy(phase = UpdatePhase.READY, release = info, lastCheckedAt = now) }
                return@withContext _state.value
            }
            discardDownload()
            _state.update {
                it.copy(
                    phase = UpdatePhase.AVAILABLE, release = info, downloadedPath = null,
                    progress = 0f, downloadedBytes = 0L, lastCheckedAt = now
                )
            }
            if (prefsNow.updateAutoInstall && apk != null) download()
            _state.value
        } catch (e: Exception) {
            val message = friendly(e)
            Log.w(TAG, "update check failed: $message")
            val keepReady = prev.phase == UpdatePhase.READY && prev.downloadedPath != null
            _state.update {
                it.copy(
                    phase = if (keepReady) UpdatePhase.READY else UpdatePhase.ERROR,
                    error = message,
                    lastCheckedAt = System.currentTimeMillis()
                )
            }
            _state.value
        }
    }

    private fun fetchReleases(): List<GithubReleaseDto> {
        val request = Request.Builder()
            .url("$apiBase/repos/$repo/releases?per_page=30")
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "Murmur-Android/${BuildConfig.VERSION_NAME}")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .build()
        client.newCall(request).execute().use { res ->
            if ((res.code == 403 || res.code == 429) && res.header("x-ratelimit-remaining") == "0") {
                throw UpdateException("GitHub API rate limit reached. Try again in a while.")
            }
            if (res.code == 404) throw UpdateException("No releases found for $repo. Is the repository public and released?")
            if (!res.isSuccessful) throw UpdateException("GitHub returned HTTP ${res.code}")
            val body = res.body?.string() ?: throw UpdateException("Empty response from GitHub")
            return UpdateSelection.parseReleases(body)
        }
    }

    private fun fetchChecksum(release: GithubReleaseDto, assetName: String): String? {
        val sums = release.assets.firstOrNull { it.name == UpdateSelection.CHECKSUMS_ASSET } ?: run {
            Log.w(TAG, "${release.tag_name} ships no ${UpdateSelection.CHECKSUMS_ASSET}; installing is disabled")
            return null
        }
        if (!UpdateSelection.isTrustedAssetUrl(sums.browser_download_url, downloadOrigin)) return null
        return try {
            val request = Request.Builder().url(sums.browser_download_url)
                .header("User-Agent", "Murmur-Android/${BuildConfig.VERSION_NAME}").build()
            client.newCall(request).execute().use { res ->
                if (!res.isSuccessful) throw UpdateException("HTTP ${res.code}")
                UpdateSelection.parseChecksums(res.body?.string() ?: "")[assetName]
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not fetch checksums: ${e.message}")
            null
        }
    }

    // ---- downloading ----------------------------------------------------------------------------

    fun download() {
        if (downloadJob?.isActive == true) return
        downloadJob = scope.launch { doDownload() }
    }

    fun cancelDownload() {
        downloadJob?.cancel()
    }

    private suspend fun doDownload() {
        val st = _state.value
        val info = st.release ?: return
        val apk = info.apk ?: return
        if (st.phase == UpdatePhase.DOWNLOADING || st.phase == UpdatePhase.INSTALLING) return
        if (st.phase == UpdatePhase.READY && st.downloadedPath != null && File(st.downloadedPath).exists()) return
        val dir = downloadDir()
        val dest = File(dir, apk.name)
        val part = File(dir, apk.name + ".part")
        _state.update {
            it.copy(phase = UpdatePhase.DOWNLOADING, progress = 0f, downloadedBytes = 0L, error = null, downloadedPath = null)
        }
        Log.i(TAG, "downloading ${apk.browser_download_url} (${apk.size} bytes)")
        try {
            withContext(Dispatchers.IO) {
                val request = Request.Builder().url(apk.browser_download_url)
                    .header("User-Agent", "Murmur-Android/${BuildConfig.VERSION_NAME}").build()
                client.newCall(request).execute().use { res ->
                    if (!res.isSuccessful) throw UpdateException("Download failed: HTTP ${res.code}")
                    val body = res.body ?: throw UpdateException("Download failed: empty response")
                    val total = if (apk.size > 0) apk.size else body.contentLength()
                    val digest = MessageDigest.getInstance("SHA-256")
                    var transferred = 0L
                    var lastEmit = 0L
                    part.outputStream().use { out ->
                        body.byteStream().use { input ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                ensureActive()
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                digest.update(buf, 0, n)
                                transferred += n
                                val now = System.currentTimeMillis()
                                if (now - lastEmit > 150) {
                                    lastEmit = now
                                    val p = if (total > 0) (transferred.toFloat() / total).coerceIn(0f, 1f) else 0f
                                    _state.update { it.copy(progress = p, downloadedBytes = transferred) }
                                }
                            }
                        }
                    }
                    if (apk.size > 0 && transferred != apk.size) {
                        throw UpdateException("Download is $transferred bytes, expected ${apk.size}")
                    }
                    val hex = digest.digest().joinToString("") { "%02x".format(it) }
                    if (info.sha256 != null && hex != info.sha256.lowercase()) {
                        throw UpdateException("The downloaded file did not match the release checksum, so it was discarded.")
                    }
                    dest.delete()
                    if (!part.renameTo(dest)) throw UpdateException("Could not save the download")
                }
            }
            Log.i(TAG, "downloaded and ${if (info.sha256 != null) "verified" else "saved (unverified)"}: $dest")
            _state.update { it.copy(phase = UpdatePhase.READY, downloadedPath = dest.absolutePath, progress = 1f) }
            if (settings.get().updateAutoInstall && _state.value.canInstall) scope.launch { autoInstall() }
        } catch (e: CancellationException) {
            part.delete()
            _state.update { it.copy(phase = UpdatePhase.AVAILABLE, progress = 0f, downloadedBytes = 0L) }
            throw e
        } catch (e: Exception) {
            part.delete()
            val message = friendly(e)
            Log.w(TAG, "download failed: $message")
            _state.update {
                it.copy(phase = UpdatePhase.ERROR, error = message, progress = 0f, downloadedBytes = 0L, downloadedPath = null)
            }
        }
    }

    // ---- installing -----------------------------------------------------------------------------

    @Volatile
    private var awaitingPermission = false

    /**
     * Unattended path: wait until nothing is being dictated, then commit the session. Android
     * either applies it silently (self-update, 12+) or answers with a confirmation we surface as
     * a notification; a missing "install unknown apps" grant also becomes a notification.
     */
    private suspend fun autoInstall() {
        var waited = 0L
        while (!isIdle() && waited < IDLE_WAIT_MAX_MS) {
            delay(IDLE_POLL_MS)
            waited += IDLE_POLL_MS
        }
        val st = _state.value
        if (st.phase != UpdatePhase.READY || !st.canInstall || !settings.get().updateAutoInstall) return
        if (!hasInstallPermission()) {
            _state.update { it.copy(needsInstallPermission = true) }
            notify(
                NOTIFICATION_ID_UPDATE,
                "Murmur ${st.release?.version} is ready to install",
                "Tap to allow Murmur to install its own updates.",
                launchAppIntent()
            )
            return
        }
        install()
    }

    /** Hand the verified APK to the package installer. Returns false when something has to happen first. */
    fun install(): Boolean {
        val st = _state.value
        val release = st.release
        val path = st.downloadedPath
        if (release == null || path == null || !st.canInstall) return false
        val file = File(path)
        if (!file.exists()) {
            _state.update {
                it.copy(phase = UpdatePhase.AVAILABLE, downloadedPath = null, error = "The downloaded file is gone. Download it again.")
            }
            return false
        }
        if (!hasInstallPermission()) {
            awaitingPermission = true
            _state.update { it.copy(needsInstallPermission = true) }
            return false
        }
        _state.update { it.copy(phase = UpdatePhase.INSTALLING, error = null) }
        prefs.edit()
            .putString(KEY_PENDING_VERSION, release.version)
            .putString(KEY_PENDING_FROM, BuildConfig.VERSION_NAME)
            .commit()
        scope.launch(Dispatchers.IO) {
            try {
                val installer = app.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(app.packageName)
                    setSize(file.length())
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
                    }
                }
                val sessionId = installer.createSession(params)
                installer.openSession(sessionId).use { session ->
                    session.openWrite("murmur.apk", 0, file.length()).use { out ->
                        file.inputStream().use { it.copyTo(out) }
                        session.fsync(out)
                    }
                    val intent = Intent(app, UpdateResultReceiver::class.java).setAction(UpdateResultReceiver.ACTION)
                    var flags = PendingIntent.FLAG_UPDATE_CURRENT
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
                    val pending = PendingIntent.getBroadcast(app, sessionId, intent, flags)
                    Log.i(TAG, "committing install session $sessionId for ${release.version}")
                    session.commit(pending.intentSender)
                }
            } catch (e: Exception) {
                Log.e(TAG, "could not start the installer", e)
                clearPending()
                _state.update { it.copy(phase = UpdatePhase.READY, error = "Could not start the installer: ${e.message}") }
            }
        }
        return true
    }

    /** Result of a committed session, delivered through [UpdateResultReceiver]. */
    fun onInstallStatus(status: Int, message: String?, confirmIntent: Intent?) {
        val version = _state.value.release?.version ?: ""
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                if (confirmIntent == null) return
                confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (foreground) {
                    try {
                        app.startActivity(confirmIntent)
                        return
                    } catch (e: Exception) {
                        Log.w(TAG, "could not show the install confirmation directly", e)
                    }
                }
                notify(
                    NOTIFICATION_ID_UPDATE,
                    "Finish installing Murmur $version",
                    "Tap to confirm the update.",
                    PendingIntent.getActivity(app, 1, confirmIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                )
            }
            PackageInstaller.STATUS_SUCCESS -> {
                // The system replaces the package and restarts the process; nothing else to do.
                Log.i(TAG, "update $version installed")
                cancelNotification(NOTIFICATION_ID_UPDATE)
            }
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                Log.i(TAG, "install cancelled")
                clearPending()
                _state.update { it.copy(phase = UpdatePhase.READY, error = null) }
            }
            else -> {
                val friendly = when (status) {
                    PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                        "This update is signed with a different key than the installed Murmur (debug vs release build). Uninstall Murmur, then install the new APK."
                    PackageInstaller.STATUS_FAILURE_STORAGE -> "Not enough storage to install the update."
                    PackageInstaller.STATUS_FAILURE_BLOCKED -> "The install was blocked by a device policy or Play Protect."
                    PackageInstaller.STATUS_FAILURE_INVALID -> "The downloaded file is not a valid Murmur APK."
                    else -> "Install failed${if (message.isNullOrBlank()) "" else ": $message"}"
                }
                Log.w(TAG, "install failed ($status): $message")
                clearPending()
                _state.update { it.copy(phase = UpdatePhase.READY, error = friendly) }
            }
        }
    }

    // ---- permissions ----------------------------------------------------------------------------

    fun hasInstallPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || app.packageManager.canRequestPackageInstalls()

    fun refreshInstallPermission() {
        _state.update { it.copy(needsInstallPermission = !hasInstallPermission()) }
    }

    /** Open the system screen where the user allows Murmur to install apps. */
    fun requestInstallPermission(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        awaitingPermission = true
        context.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    // ---- user actions ---------------------------------------------------------------------------

    /** Dismiss the offered version until a newer one shows up. */
    fun skip() {
        val release = _state.value.release ?: return
        cancelDownload()
        settings.update { it.copy(updateSkippedVersion = release.version) }
        discardDownload()
        _state.update {
            it.copy(phase = UpdatePhase.UP_TO_DATE, release = null, downloadedPath = null, progress = 0f, downloadedBytes = 0L, error = null)
        }
        cancelNotification(NOTIFICATION_ID_UPDATE)
    }

    fun ackUpdated() {
        _state.update { it.copy(updatedFrom = null) }
    }

    fun openReleasePage(context: Context) {
        val url = _state.value.release?.url ?: releasesPageUrl
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    // ---- background -----------------------------------------------------------------------------

    /**
     * Daily check while the accessibility service is alive (the only long-lived part of the app).
     * Finds -> downloads -> installs when "install automatically" is on, otherwise notifies.
     */
    fun startBackgroundChecks(scope: CoroutineScope) {
        scope.launch {
            while (isActive) {
                if (!settings.get().updateAutoCheck) {
                    delay(TimeUnit.MINUTES.toMillis(30))
                    continue
                }
                val due = _state.value.lastCheckedAt + BACKGROUND_INTERVAL_MS - System.currentTimeMillis()
                if (due > 0) {
                    delay(due)
                    continue
                }
                val st = check(manual = false)
                if ((st.phase == UpdatePhase.AVAILABLE || st.phase == UpdatePhase.READY) && st.release != null &&
                    !(settings.get().updateAutoInstall && st.release.apk != null && st.release.sha256 != null)
                ) {
                    notify(
                        NOTIFICATION_ID_UPDATE,
                        "Murmur ${st.release.version} is available",
                        "Open Murmur to download and install it.",
                        launchAppIntent()
                    )
                }
                delay(BACKGROUND_INTERVAL_MS)
            }
        }
    }

    // ---- helpers --------------------------------------------------------------------------------

    private fun downloadDir(): File = File(app.cacheDir, "updates").apply { mkdirs() }

    private fun discardDownload() {
        _state.value.downloadedPath?.let { File(it).delete() }
    }

    private fun cleanDownloads() {
        runCatching { downloadDir().listFiles()?.forEach { it.delete() } }
    }

    private fun clearPending() {
        prefs.edit().remove(KEY_PENDING_VERSION).remove(KEY_PENDING_FROM).apply()
    }

    private fun launchAppIntent(): PendingIntent = PendingIntent.getActivity(
        app, 0,
        app.packageManager.getLaunchIntentForPackage(app.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    private fun notify(id: Int, title: String, text: String, tap: PendingIntent) {
        try {
            val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, app.getString(R.string.notification_channel_updates), NotificationManager.IMPORTANCE_DEFAULT)
                )
            }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(app, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION") Notification.Builder(app)
            }
            nm.notify(
                id,
                builder.setSmallIcon(R.drawable.ic_mic_notification)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setContentIntent(tap)
                    .setAutoCancel(true)
                    .build()
            )
        } catch (e: Exception) {
            // Notifications denied: the Updates card still shows everything the next time the app opens.
            Log.w(TAG, "could not post the update notification: ${e.message}")
        }
    }

    private fun cancelNotification(id: Int) {
        runCatching { (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(id) }
    }

    private fun friendly(e: Exception): String = when (e) {
        is UpdateException -> e.message ?: "Update failed"
        is IOException -> "Could not reach GitHub. Check your connection and try again."
        else -> e.message ?: "Update failed"
    }

    companion object {
        private const val KEY_LAST_CHECKED = "lastCheckedAt"
        private const val KEY_PENDING_VERSION = "pendingVersion"
        private const val KEY_PENDING_FROM = "pendingFrom"
        private const val CHANNEL_ID = "murmur_updates"
        private const val NOTIFICATION_ID_UPDATE = 1292
        private val FOREGROUND_INTERVAL_MS = TimeUnit.HOURS.toMillis(1)
        private val BACKGROUND_INTERVAL_MS = TimeUnit.HOURS.toMillis(24)
        private val IDLE_POLL_MS = TimeUnit.SECONDS.toMillis(20)
        private val IDLE_WAIT_MAX_MS = TimeUnit.MINUTES.toMillis(30)

        @Volatile
        private var instance: UpdateManager? = null

        fun get(context: Context): UpdateManager =
            instance ?: synchronized(this) {
                instance ?: UpdateManager(context.applicationContext, SettingsStore.get(context)).also { instance = it }
            }
    }
}
