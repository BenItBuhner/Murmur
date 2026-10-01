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
import app.murmur.android.MainActivity
import app.murmur.android.R
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.Route
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
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
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

/** Where the updater looks and what it believes it is running; the app uses the defaults, tests point them at a fake GitHub. */
data class UpdateSource(
    /** `owner/name` on GitHub. */
    val repo: String = BuildConfig.UPDATE_REPO,
    val currentVersion: String = BuildConfig.VERSION_NAME,
    val apiBase: String = "https://api.github.com",
    /** Only assets served from this origin are downloaded. */
    val downloadOrigin: String = "https://github.com",
    /** Pauses before the second and third attempt at downloading SHA256SUMS.txt. */
    val checksumRetryDelaysMs: List<Long> = listOf(1_000L, 3_000L)
)

/**
 * Android counterpart of apps/desktop/src/main/update/service.ts: reads the repository's GitHub
 * Releases, downloads `Murmur-<version>-android.apk` and verifies it against the checksum the
 * release carries for it. Checking and downloading happen on their own (when the app opens, daily
 * from the accessibility service); handing the file to the system package installer never does.
 *
 * Installing is the user's call, always: the one way to the installer is [install], which the
 * Install button on the Updates screen calls, and nothing else does. Play Protect looks at every
 * install, and on current Android it asked, or refused, every time the earlier build installed in
 * the background; now that happens once, when the user has just tapped Install and is looking at
 * the screen. A build that finished downloading while the app was away is announced by a single
 * quiet notification per version that opens the Updates screen.
 *
 * The checksum is GitHub's own digest of the uploaded asset, which arrives in the same API response
 * as the asset list; a release whose assets carry no digest falls back to its SHA256SUMS.txt. A
 * checksum that cannot be fetched is a check failure to retry, never a reason to download an APK
 * that can then not be verified.
 *
 * With UPDATE_PACKAGES_WITHOUT_USER_ACTION and a PackageInstaller session, Android 12+ applies the
 * update the user asked for without a second system dialog once the app has been the installer of
 * its current version; the very first in-app update shows the system confirmation.
 */
class UpdateManager internal constructor(
    private val app: Context,
    private val settings: SettingsStore,
    private val source: UpdateSource = UpdateSource()
) : Updater {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val prefs = app.getSharedPreferences("murmur_updater", Context.MODE_PRIVATE)
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .build()
    private val checkMutex = Mutex()
    private var downloadJob: Job? = null

    private val repo = source.repo
    private val apiBase = source.apiBase
    private val downloadOrigin = source.downloadOrigin
    private val currentVersion = source.currentVersion

    /** Hands a verified APK to the platform; the outcome arrives through [UpdateResultReceiver]. Tests swap it. */
    internal var commitInstall: (file: File, version: String) -> Unit = ::commitToPackageInstaller

    private val _state = MutableStateFlow(
        UpdateState(currentVersion = currentVersion, lastCheckedAt = prefs.getLong(KEY_LAST_CHECKED, 0L))
    )
    val state: StateFlow<UpdateState> = _state

    override val readyVersion: StateFlow<String?> =
        _state.map { if (it.canInstall) it.release?.version else null }.stateIn(scope, SharingStarted.Eagerly, null)

    /**
     * Whether MainActivity is in front. Decides where a ready build is announced (the Home card
     * and the drawer dot in the app, a notification otherwise) and where the system's install
     * confirmation goes once the user has tapped Install.
     */
    @Volatile
    private var foreground: Boolean = false

    init {
        val pendingVersion = prefs.getString(KEY_PENDING_VERSION, null)
        if (pendingVersion != null) {
            if (pendingVersion == currentVersion) {
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

    /** The app came to the front: refresh the install permission and check when it is time. */
    override fun onAppVisible() {
        foreground = true
        refreshInstallPermission()
        val st = _state.value
        if (settings.get().updateAutoCheck &&
            st.phase != UpdatePhase.DOWNLOADING && st.phase != UpdatePhase.INSTALLING &&
            System.currentTimeMillis() - st.lastCheckedAt > FOREGROUND_INTERVAL_MS
        ) {
            checkAsync(manual = false)
        }
    }

    override fun onAppHidden() {
        foreground = false
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
                currentVersion,
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
            val checksum = if (apk != null) lookupChecksum(chosen, apk) else null
            if (checksum is Checksum.Unavailable) {
                // A network hiccup on the checksum, not a defect of the release: report it as one and
                // leave the APK alone, so the next check (soon, see startBackgroundChecks) tries again.
                throw UpdateException(checksum.reason)
            }
            val info = UpdateSelection.describe(chosen, apk, checksum)
            Log.i(
                TAG,
                "update available: ${info.version} (${apk?.name ?: "no APK"}, " +
                    when (checksum) {
                        is Checksum.Known -> "checksum from ${checksum.source}"
                        is Checksum.Missing -> "no checksum: ${checksum.reason}"
                        else -> "no checksum"
                    } + ")"
            )

            // A file downloaded earlier is only kept when it was verified against this very checksum;
            // anything else is re-downloaded so the digest check runs on what gets installed.
            val prevRelease = prev.release
            val sameDownload = prev.phase == UpdatePhase.READY && prev.downloadedPath != null &&
                File(prev.downloadedPath).exists() && prevRelease != null && prevRelease.version == info.version &&
                prevRelease.sha256 != null && prevRelease.sha256 == info.sha256
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
            // Without a checksum nothing could be verified, so nothing is fetched unattended.
            if (prefsNow.updateAutoDownload && apk != null && info.sha256 != null) download()
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
            .header("User-Agent", "Murmur-Android/$currentVersion")
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

    /**
     * The checksum to verify [apk] against. GitHub's digest of the upload needs no further request;
     * only a release whose assets carry none has its SHA256SUMS.txt downloaded (a few attempts, the
     * file is small). See [UpdateSelection.resolveChecksum] for how the outcomes are told apart.
     */
    private suspend fun lookupChecksum(release: GithubReleaseDto, apk: GithubAssetDto): Checksum {
        val sums = release.assets.firstOrNull { it.name == UpdateSelection.CHECKSUMS_ASSET }
        if (UpdateSelection.digestOf(apk) != null || sums == null) {
            // Known from the digest, or Missing: neither needs the network.
            return UpdateSelection.resolveChecksum(release, apk, sumsPresent = sums != null, sums = null)
        }
        if (!UpdateSelection.isTrustedAssetUrl(sums.browser_download_url, downloadOrigin)) {
            Log.w(TAG, "ignoring ${UpdateSelection.CHECKSUMS_ASSET} served from an unexpected origin: ${sums.browser_download_url}")
            return Checksum.Missing("${UpdateSelection.CHECKSUMS_ASSET} of this release is served from an unexpected origin, so Murmur cannot verify it.")
        }
        var failure: String? = null
        for ((attempt, pause) in (listOf(0L) + source.checksumRetryDelaysMs).withIndex()) {
            if (pause > 0) delay(pause)
            try {
                val request = Request.Builder().url(sums.browser_download_url)
                    .header("User-Agent", "Murmur-Android/$currentVersion").build()
                val text = client.newCall(request).execute().use { res ->
                    if (!res.isSuccessful) throw UpdateException("HTTP ${res.code}")
                    res.body?.string() ?: throw UpdateException("empty response")
                }
                return UpdateSelection.resolveChecksum(release, apk, sumsPresent = true, sums = text)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = if (e is IOException) "connection failed" else e.message ?: e.javaClass.simpleName
                Log.w(TAG, "could not fetch ${UpdateSelection.CHECKSUMS_ASSET} (attempt ${attempt + 1}): ${e.message}")
            }
        }
        return UpdateSelection.resolveChecksum(release, apk, sumsPresent = true, sums = null, sumsFetchError = failure)
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
        val expectedSha256 = info.sha256
        if (expectedSha256 == null) {
            // An APK nothing can verify would only ever sit in the cache: the release page is the way.
            _state.update {
                it.copy(error = info.checksumProblem ?: "Murmur cannot verify this release's Android build, so it will not download it.")
            }
            return
        }
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
                    .header("User-Agent", "Murmur-Android/$currentVersion").build()
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
                    if (hex != expectedSha256.lowercase()) {
                        throw UpdateException("The downloaded file did not match the release checksum, so it was discarded.")
                    }
                    dest.delete()
                    if (!part.renameTo(dest)) throw UpdateException("Could not save the download")
                }
            }
            Log.i(TAG, "downloaded and verified: $dest")
            _state.update { it.copy(phase = UpdatePhase.READY, downloadedPath = dest.absolutePath, progress = 1f) }
            // The user may have left while it downloaded: say so, once. In the app the Home card and
            // the drawer's dot already do.
            if (!foreground) announce(_state.value)
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

    /**
     * Hand the verified APK to the package installer. The only way into the installer, and it is
     * called from one place: the Install button on the Updates screen. No check, download, timer or
     * permission change leads here on its own. Returns false when something has to happen first.
     */
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
            _state.update { it.copy(needsInstallPermission = true) }
            return false
        }
        _state.update { it.copy(phase = UpdatePhase.INSTALLING, error = null) }
        prefs.edit()
            .putString(KEY_PENDING_VERSION, release.version)
            .putString(KEY_PENDING_FROM, currentVersion)
            .commit()
        cancelNotification(NOTIFICATION_ID_UPDATE)
        scope.launch(Dispatchers.IO) {
            try {
                commitInstall(file, release.version)
            } catch (e: Exception) {
                Log.e(TAG, "could not start the installer", e)
                clearPending()
                _state.update { it.copy(phase = UpdatePhase.READY, error = "Could not start the installer: ${e.message}") }
            }
        }
        return true
    }

    /** Streams [file] into a PackageInstaller session and commits it; the result comes back as a broadcast. */
    private fun commitToPackageInstaller(file: File, version: String) {
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
            Log.i(TAG, "committing install session $sessionId for $version")
            session.commit(pending.intentSender)
        }
    }

    /** Result of a committed session, delivered through [UpdateResultReceiver]. */
    fun onInstallStatus(status: Int, message: String?, confirmIntent: Intent?) {
        val version = _state.value.release?.version ?: ""
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // The system wants the user to confirm the install they just asked for: in front of
                // them when the app is in front, otherwise as the tap that brings it back.
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
                    "Finish installing Murmur $version",
                    "Tap to confirm the update you started.",
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

    /**
     * Open the system screen where the user allows Murmur to install apps. Coming back, the Updates
     * screen offers Install; nothing starts until it is tapped.
     */
    fun requestInstallPermission(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
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
     * Finds -> downloads (with "Download updates automatically") -> tells the user, who installs
     * from the Updates screen when it suits them. A check that failed (GitHub unreachable, checksum
     * not downloadable) is retried after an hour instead.
     */
    override fun startBackgroundChecks(scope: CoroutineScope) {
        scope.launch {
            while (isActive) {
                if (!settings.get().updateAutoCheck) {
                    delay(TimeUnit.MINUTES.toMillis(30))
                    continue
                }
                val due = _state.value.lastCheckedAt + nextCheckInterval(_state.value.phase) - System.currentTimeMillis()
                if (due > 0) {
                    delay(due)
                    continue
                }
                val st = backgroundCycle()
                delay(nextCheckInterval(st.phase))
            }
        }
    }

    /**
     * One round of the background loop: check, wait for the download the check may have started,
     * then announce what came of it (once per version, and not while the app is in front, where
     * Home and the drawer show it). Never installs.
     */
    internal suspend fun backgroundCycle(): UpdateState {
        check(manual = false)
        downloadJob?.join()
        val st = _state.value
        if (!foreground) announce(st)
        return st
    }

    /**
     * One quiet notification per version and stage: "ready to install" once a verified download
     * is waiting, "available" when a release could not be fetched unattended (no auto-download, or
     * nothing to verify it against). Tapping it opens the Updates screen; a re-check that finds the
     * same version says nothing new.
     */
    private fun announce(st: UpdateState) {
        val release = st.release ?: return
        val stage = when {
            st.canInstall -> STAGE_READY
            st.phase == UpdatePhase.AVAILABLE -> STAGE_AVAILABLE
            else -> return
        }
        val key = "$stage:${release.version}"
        if (prefs.getString(KEY_ANNOUNCED, null) == key) return
        prefs.edit().putString(KEY_ANNOUNCED, key).apply()
        if (stage == STAGE_READY) {
            notify("Murmur ${release.version} is ready to install", "Tap to open Updates and install it.", updatesScreenIntent())
        } else {
            val text = if (release.apk != null && release.sha256 != null) "Tap to open Updates and download it."
            else "Tap to open Updates to see it."
            notify("Murmur ${release.version} is available", text, updatesScreenIntent())
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

    /** Brings Murmur to the front on the Updates screen (the activity is a single task). */
    private fun updatesScreenIntent(): PendingIntent = PendingIntent.getActivity(
        app, 0,
        MainActivity.intentFor(app, Route.UPDATES).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    /** Posts (or replaces) the one update notification: low importance, so it neither sounds nor pops over the screen. */
    private fun notify(title: String, text: String, tap: PendingIntent) {
        try {
            val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Builds up to 0.6.3 announced on a default-importance channel; a channel's
                // importance is the user's once created, so the quiet one is a new channel.
                nm.deleteNotificationChannel(LEGACY_CHANNEL_ID)
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, app.getString(R.string.notification_channel_updates), NotificationManager.IMPORTANCE_LOW)
                )
            }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(app, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION") Notification.Builder(app).setPriority(Notification.PRIORITY_LOW)
            }
            nm.notify(
                NOTIFICATION_ID_UPDATE,
                builder.setSmallIcon(R.drawable.ic_mic_notification)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setContentIntent(tap)
                    .setOnlyAlertOnce(true)
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
        /** `<stage>:<version>` of the last notification posted, so each version is announced once per stage. */
        private const val KEY_ANNOUNCED = "announced"
        private const val STAGE_READY = "ready"
        private const val STAGE_AVAILABLE = "available"
        private const val LEGACY_CHANNEL_ID = "murmur_updates"
        const val CHANNEL_ID = "murmur_updates_quiet"
        const val NOTIFICATION_ID_UPDATE = 1292
        private val FOREGROUND_INTERVAL_MS = TimeUnit.HOURS.toMillis(1)
        private val BACKGROUND_INTERVAL_MS = TimeUnit.HOURS.toMillis(24)
        private val RETRY_INTERVAL_MS = TimeUnit.HOURS.toMillis(1)

        /** How long the background loop waits after a check that ended in [phase]. */
        internal fun nextCheckInterval(phase: UpdatePhase): Long =
            if (phase == UpdatePhase.ERROR) RETRY_INTERVAL_MS else BACKGROUND_INTERVAL_MS

        @Volatile
        private var instance: UpdateManager? = null

        fun get(context: Context): UpdateManager =
            instance ?: synchronized(this) {
                instance ?: UpdateManager(context.applicationContext, SettingsStore.get(context)).also { instance = it }
            }
    }
}
