package app.murmur.android

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.Route
import app.murmur.android.update.UpdateManager
import app.murmur.android.update.UpdatePhase
import app.murmur.android.update.UpdateSource
import app.murmur.android.update.UpdateState
import java.io.File
import java.net.InetAddress
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The whole Android update flow against a fake GitHub that answers with the real API responses
 * for v0.6.0 and v0.5.11 ([UpdateFixtures]). Only the 36 MB APK is stood in for by a small payload
 * whose size and digest the release JSON is rewritten to describe.
 *
 * The contract under test: Murmur checks and downloads on its own, verifies what it fetched, and
 * then waits. The package installer is reached through [UpdateManager.install] alone, which the
 * Install button calls; no check, download, notification or permission grant ever reaches it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UpdateManagerTest {
    private val server = MockWebServer()
    private lateinit var app: Application
    private lateinit var origin: String

    /** Bytes the fake download host serves as the APK. */
    private val apk = ByteArray(200_000) { (it * 31 + it / 7).toByte() }

    private var releases: List<JsonObject> = emptyList()
    private var apiStatus = 200
    private var sumsStatus = 200
    private var sumsBody: (String) -> String = { tag -> UpdateFixtures.checksumsForApkPayload(tag, apk) }
    private var corruptApk = false
    private val requests = mutableListOf<String>()
    private val installed = mutableListOf<Pair<File, String>>()

    private val v060 = UpdateFixtures.parse(UpdateFixtures.releaseJson("v0.6.0"))
    private val v0511 = UpdateFixtures.parse(UpdateFixtures.releaseJson("v0.5.11"))

    @Before
    fun start() {
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        origin = "http://127.0.0.1:${server.port}"
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                synchronized(requests) { requests += path }
                val download = Regex("""^/${UpdateFixtures.REPO}/releases/download/([^/]+)/(.+)$""").find(path)
                return when {
                    path.startsWith("/repos/${UpdateFixtures.REPO}/releases") ->
                        if (apiStatus != 200) MockResponse().setResponseCode(apiStatus).setBody("nope")
                        else MockResponse().setHeader("Content-Type", "application/json; charset=utf-8")
                            .setBody(UpdateFixtures.listBody(origin, *releases.toTypedArray()))
                    download != null && download.groupValues[2] == "SHA256SUMS.txt" ->
                        if (sumsStatus != 200) MockResponse().setResponseCode(sumsStatus)
                        else MockResponse().setHeader("Content-Type", "application/octet-stream").setBody(sumsBody(download.groupValues[1]))
                    download != null && download.groupValues[2].endsWith("-android.apk") -> {
                        val body = if (corruptApk) ByteArray(apk.size) { (apk[it].toInt() xor 0xff).toByte() } else apk
                        MockResponse().setHeader("Content-Type", "application/vnd.android.package-archive").setBody(Buffer().write(body))
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        app = ApplicationProvider.getApplicationContext()
        shadowOf(app.packageManager).setCanRequestPackageInstalls(true)
        app.getSharedPreferences("murmur_updater", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @After
    fun stop() = server.shutdown()

    /**
     * A manager against the fake GitHub. Automatic checks are off so only the test drives it
     * (`onAppVisible` would otherwise start one); automatic downloads are on, as shipped.
     */
    private fun manager(currentVersion: String, autoDownload: Boolean = true): UpdateManager {
        val settings = SettingsStore(app)
        settings.update { it.copy(updateAutoDownload = autoDownload, updateAutoCheck = false) }
        val source = UpdateSource(UpdateFixtures.REPO, currentVersion, origin, origin, checksumRetryDelaysMs = listOf(10L, 10L))
        return UpdateManager(app, settings, source).also { m ->
            m.commitInstall = { file, version -> synchronized(installed) { installed += file to version } }
        }
    }

    private suspend fun UpdateManager.awaitPhase(vararg phases: UpdatePhase): UpdateState =
        withTimeout(20_000) { state.first { it.phase in phases } }

    private suspend fun awaitInstall(): Pair<File, String> = withTimeout(20_000) {
        while (synchronized(installed) { installed.isEmpty() }) delay(20)
        synchronized(installed) { installed.single() }
    }

    private fun installs(): Int = synchronized(installed) { installed.size }

    /** [UpdateManager.readyVersion] follows the state on the manager's own scope; wait for it to catch up. */
    private suspend fun UpdateManager.awaitReadyVersion(expected: String?): Unit =
        withTimeout(5_000) { readyVersion.first { it == expected } }

    private fun requested(suffix: String): Int = synchronized(requests) { requests.count { it.endsWith(suffix) } }

    private fun pendingPrefs(): Pair<String?, String?> =
        app.getSharedPreferences("murmur_updater", Context.MODE_PRIVATE).let { it.getString("pendingVersion", null) to it.getString("pendingFrom", null) }

    private val notificationManager get() = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val notifications get() = shadowOf(notificationManager)

    private fun Notification.title(): String? = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
    private fun Notification.text(): String? = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()

    /** Downloads and verifies [fixture], then stops: the user has not tapped Install. */
    private fun downloadsFromDigest(fixture: JsonObject, tag: String, from: String, others: List<JsonObject>) = runBlocking {
        val version = tag.removePrefix("v")
        releases = listOf(UpdateFixtures.withApkPayload(fixture, apk)) + others
        val m = manager(from)

        val found = m.check(manual = false)
        // The check kicks the download off before it returns; the state may already be past AVAILABLE.
        assertTrue(found.error, found.phase in setOf(UpdatePhase.AVAILABLE, UpdatePhase.DOWNLOADING, UpdatePhase.READY))
        assertEquals(version, found.release?.version)
        assertEquals("Murmur-$version-android.apk", found.release?.apk?.name)
        assertEquals(UpdateFixtures.sha256Hex(apk), found.release?.sha256)
        assertNull(found.release?.checksumProblem)

        // "Download updates automatically" is on: download and verify, then wait for the user.
        val ready = m.awaitPhase(UpdatePhase.READY, UpdatePhase.ERROR)
        assertEquals(ready.error, UpdatePhase.READY, ready.phase)
        assertTrue(ready.canInstall)
        assertEquals(UpdateFixtures.sha256Hex(apk), UpdateFixtures.sha256Hex(File(ready.downloadedPath!!).readBytes()))
        m.awaitReadyVersion(version)
        delay(300)
        assertEquals("nothing reaches the installer on its own", 0, installs())
        assertEquals(UpdatePhase.READY, m.state.value.phase)
        assertEquals(null to null, pendingPrefs())

        // The digest came with the release JSON: the checksum file was never needed.
        assertEquals(0, requested("SHA256SUMS.txt"))
        assertEquals(1, requested("-android.apk"))

        // The user's tap is what hands the verified file over, once.
        assertTrue(m.install())
        val (file, installedVersion) = awaitInstall()
        assertEquals(version, installedVersion)
        assertEquals("Murmur-$version-android.apk", file.name)
        assertEquals(UpdateFixtures.sha256Hex(apk), UpdateFixtures.sha256Hex(file.readBytes()))
        assertEquals(version to from, pendingPrefs())
        assertEquals(UpdatePhase.INSTALLING, m.state.value.phase)
        m.awaitReadyVersion(null)
        assertFalse("a second tap while the installer runs does nothing", m.install())
        assertEquals(1, installs())
    }

    @Test
    fun `a 0-5-11 phone verifies v0-6-0 against the release's asset digest and holds it for the user's Install tap`() =
        downloadsFromDigest(v060, "v0.6.0", from = "0.5.11", others = listOf(v0511))

    /** The feed as a 0.5.10 phone saw it before v0.6.0 existed. */
    @Test
    fun `a 0-5-10 phone verifies v0-5-11 the same way`() =
        downloadsFromDigest(v0511, "v0.5.11", from = "0.5.10", others = emptyList())

    @Test
    fun `a release whose assets carry no digest is verified against its SHA256SUMS txt`() = runBlocking {
        releases = listOf(UpdateFixtures.withoutDigests(UpdateFixtures.withApkPayload(v060, apk)), v0511)
        val m = manager("0.5.11")
        val found = m.check(manual = false)
        assertTrue(found.error, found.phase != UpdatePhase.ERROR)
        assertEquals(UpdateFixtures.sha256Hex(apk), found.release?.sha256)
        assertEquals(1, requested("SHA256SUMS.txt"))
        val ready = m.awaitPhase(UpdatePhase.READY, UpdatePhase.ERROR)
        assertEquals(ready.error, UpdatePhase.READY, ready.phase)
        m.awaitReadyVersion("0.6.0")
        delay(200)
        assertEquals(0, installs())
    }

    @Test
    fun `a checksum file that cannot be downloaded is a retried download error, not a release without checksums`() = runBlocking {
        releases = listOf(UpdateFixtures.withoutDigests(UpdateFixtures.withApkPayload(v060, apk)), v0511)
        sumsStatus = 503
        val m = manager("0.5.11")

        val failed = m.check(manual = false)
        assertEquals(UpdatePhase.ERROR, failed.phase)
        assertTrue(failed.error, failed.error!!.contains("Could not download SHA256SUMS.txt for Murmur 0.6.0"))
        assertTrue(failed.error, failed.error.contains("HTTP 503"))
        assertFalse(failed.error, failed.error.contains("ships no"))
        assertNull(failed.release)
        assertFalse(failed.canInstall)
        // Three attempts at the small file, and no APK: nothing could have verified it.
        assertEquals(3, requested("SHA256SUMS.txt"))
        delay(200)
        assertEquals(0, requested("-android.apk"))
        assertEquals(0, installs())

        // GitHub is back: the next check picks the update up, downloads it, and waits.
        sumsStatus = 200
        val found = m.check(manual = false)
        assertTrue(found.error, found.phase != UpdatePhase.ERROR)
        assertEquals(UpdateFixtures.sha256Hex(apk), found.release?.sha256)
        assertEquals(UpdatePhase.READY, m.awaitPhase(UpdatePhase.READY, UpdatePhase.ERROR).phase)
        delay(200)
        assertEquals(0, installs())
    }

    @Test
    fun `a release without any checksum is offered for manual install and never downloaded`() = runBlocking {
        releases = listOf(UpdateFixtures.withoutChecksumsAsset(UpdateFixtures.withoutDigests(UpdateFixtures.withApkPayload(v060, apk))), v0511)
        val m = manager("0.5.11")
        val found = m.check(manual = false)
        assertEquals(UpdatePhase.AVAILABLE, found.phase)
        assertNotNull(found.release?.apk)
        assertNull(found.release?.sha256)
        assertEquals("Murmur 0.6.0 ships no SHA256SUMS.txt, so Murmur cannot verify its Android build.", found.release?.checksumProblem)
        assertFalse(found.canInstall)
        delay(200)
        assertEquals(0, requested("-android.apk"))

        // Even an explicit download is refused: an unverifiable APK could never be installed.
        m.download()
        delay(200)
        val after = m.state.value
        assertEquals(UpdatePhase.AVAILABLE, after.phase)
        assertEquals(found.release?.checksumProblem, after.error)
        assertEquals(0, requested("-android.apk"))
        assertFalse(m.install())
        assertEquals(0, installs())
    }

    @Test
    fun `a checksum file without a line for the APK refuses`() = runBlocking {
        releases = listOf(UpdateFixtures.withoutDigests(UpdateFixtures.withApkPayload(v060, apk)), v0511)
        sumsBody = { tag -> UpdateFixtures.checksums(tag).lines().filterNot { it.endsWith("-android.apk") }.joinToString("\n") }
        val m = manager("0.5.11")
        val found = m.check(manual = false)
        assertEquals(UpdatePhase.AVAILABLE, found.phase)
        assertNull(found.release?.sha256)
        assertEquals(
            "The SHA256SUMS.txt of Murmur 0.6.0 has no entry for Murmur-0.6.0-android.apk, so Murmur cannot verify it.",
            found.release?.checksumProblem
        )
        delay(200)
        assertEquals(0, requested("-android.apk"))
    }

    @Test
    fun `a download that does not match the checksum is discarded`() = runBlocking {
        releases = listOf(UpdateFixtures.withApkPayload(v060, apk), v0511)
        corruptApk = true
        val m = manager("0.5.11")
        m.check(manual = false)
        val failed = m.awaitPhase(UpdatePhase.ERROR, UpdatePhase.READY)
        assertEquals(UpdatePhase.ERROR, failed.phase)
        assertTrue(failed.error, failed.error!!.contains("did not match the release checksum"))
        assertNull(failed.downloadedPath)
        assertEquals(emptyList<String>(), File(app.cacheDir, "updates").listFiles()?.map { it.name } ?: emptyList<String>())
        m.awaitReadyVersion(null)
        delay(100)
        assertFalse("nothing to install, and the tap says so", m.install())
        assertEquals(0, installs())
    }

    @Test
    fun `a re-check keeps a verified download only while the checksum is unchanged`() = runBlocking {
        releases = listOf(UpdateFixtures.withApkPayload(v060, apk), v0511)
        val m = manager("0.5.11", autoDownload = false)
        m.check(manual = true)
        m.download()
        val ready = m.awaitPhase(UpdatePhase.READY, UpdatePhase.ERROR)
        assertEquals(ready.error, UpdatePhase.READY, ready.phase)
        assertTrue(ready.canInstall)
        assertEquals(1, requested("-android.apk"))

        // Same release, same digest: the file stays and is not fetched again.
        val again = m.check(manual = true)
        assertEquals(UpdatePhase.READY, again.phase)
        assertEquals(ready.downloadedPath, again.downloadedPath)
        assertEquals(1, requested("-android.apk"))

        // GitHub unreachable: the verified file survives the failed check.
        apiStatus = 500
        val failed = m.check(manual = true)
        assertEquals(UpdatePhase.READY, failed.phase)
        assertTrue(failed.error, failed.error!!.contains("HTTP 500"))
        assertTrue(File(failed.downloadedPath!!).exists())
        apiStatus = 200

        // The release was re-uploaded with other bytes: what is on disk no longer matches and goes.
        val other = ByteArray(apk.size) { (it * 7).toByte() }
        releases = listOf(UpdateFixtures.withApkPayload(v060, other), v0511)
        val changed = m.check(manual = true)
        assertEquals(UpdatePhase.AVAILABLE, changed.phase)
        assertNull(changed.downloadedPath)
        assertFalse(File(ready.downloadedPath!!).exists())
        assertEquals(UpdateFixtures.sha256Hex(other), changed.release?.sha256)
        // Through all of it, nothing was handed to the installer.
        assertEquals(0, installs())
    }

    @Test
    fun `a failed check is retried after an hour, a good one after a day`() {
        assertEquals(60L * 60 * 1000, UpdateManager.nextCheckInterval(UpdatePhase.ERROR))
        assertEquals(24L * 60 * 60 * 1000, UpdateManager.nextCheckInterval(UpdatePhase.UP_TO_DATE))
        assertEquals(24L * 60 * 60 * 1000, UpdateManager.nextCheckInterval(UpdatePhase.READY))
    }

    // ---- the background loop: download, say so once, never install ---------------------------------

    @Test
    fun `the background cycle downloads and verifies, posts one quiet notification that opens Updates, and never installs`() = runBlocking {
        releases = listOf(UpdateFixtures.withApkPayload(v060, apk), v0511)
        // What a phone updated from 0.6.3 still has: the channel those builds announced on.
        notificationManager.createNotificationChannel(NotificationChannel("murmur_updates", "Updates", NotificationManager.IMPORTANCE_DEFAULT))
        val m = manager("0.5.11")

        val st = m.backgroundCycle()
        assertEquals(st.error, UpdatePhase.READY, st.phase)
        assertTrue(st.canInstall)
        delay(300)
        assertEquals("the daily check never reaches the installer", 0, installs())
        assertEquals(null to null, pendingPrefs())

        val posted = notifications.allNotifications
        assertEquals(1, posted.size)
        val n = posted.single()
        assertEquals("Murmur 0.6.0 is ready to install", n.title())
        assertEquals("Tap to open Updates and install it.", n.text())
        assertTrue("dismissed by the tap", n.flags and Notification.FLAG_AUTO_CANCEL != 0)
        assertTrue("does not alert again when replaced", n.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        assertEquals(UpdateManager.CHANNEL_ID, n.channelId)
        assertEquals(
            "quiet: no sound, no heads-up",
            NotificationManager.IMPORTANCE_LOW,
            notificationManager.getNotificationChannel(UpdateManager.CHANNEL_ID).importance
        )
        assertNull("the loud channel of earlier builds is gone", notificationManager.getNotificationChannel("murmur_updates"))
        val tap = shadowOf(n.contentIntent).savedIntent
        assertEquals(MainActivity::class.java.name, tap.component?.className)
        assertEquals(Route.UPDATES, MainActivity.routeFrom(tap))

        // The next days find the same version ready: nothing new to say, even after the user swiped it away.
        m.backgroundCycle()
        assertEquals(1, notifications.allNotifications.size)
        notificationManager.cancel(UpdateManager.NOTIFICATION_ID_UPDATE)
        m.backgroundCycle()
        assertEquals(0, notifications.allNotifications.size)
        assertEquals(1, requested("-android.apk"))
        assertEquals(0, installs())
    }

    @Test
    fun `with automatic downloads off the background cycle only says a version is available`() = runBlocking {
        releases = listOf(UpdateFixtures.withApkPayload(v060, apk), v0511)
        val m = manager("0.5.11", autoDownload = false)

        val st = m.backgroundCycle()
        assertEquals(UpdatePhase.AVAILABLE, st.phase)
        delay(200)
        assertEquals(0, requested("-android.apk"))
        assertEquals(0, installs())
        val n = notifications.allNotifications.single()
        assertEquals("Murmur 0.6.0 is available", n.title())
        assertEquals("Tap to open Updates and download it.", n.text())
        assertEquals(Route.UPDATES, MainActivity.routeFrom(shadowOf(n.contentIntent).savedIntent))

        // Once downloaded (the user turned downloads on, or tapped Download), the ready one replaces it, once.
        m.download()
        assertEquals(UpdatePhase.READY, m.awaitPhase(UpdatePhase.READY, UpdatePhase.ERROR).phase)
        delay(100)
        assertEquals("Murmur 0.6.0 is ready to install", notifications.allNotifications.single().title())
        notificationManager.cancel(UpdateManager.NOTIFICATION_ID_UPDATE)
        m.backgroundCycle()
        assertEquals(0, notifications.allNotifications.size)
        assertEquals(0, installs())
    }

    @Test
    fun `a download that finishes while the app is in front is shown in the app, and announced once it is not`() = runBlocking {
        releases = listOf(UpdateFixtures.withApkPayload(v060, apk), v0511)
        val m = manager("0.5.11")
        m.onAppVisible()

        m.check(manual = false)
        assertEquals(UpdatePhase.READY, m.awaitPhase(UpdatePhase.READY, UpdatePhase.ERROR).phase)
        delay(200)
        assertEquals("Home and the drawer show it; no notification over the app", 0, notifications.allNotifications.size)
        m.awaitReadyVersion("0.6.0")
        m.backgroundCycle()
        assertEquals(0, notifications.allNotifications.size)

        m.onAppHidden()
        m.backgroundCycle()
        assertEquals("Murmur 0.6.0 is ready to install", notifications.allNotifications.single().title())
        assertEquals(0, installs())
    }

    @Test
    fun `skipping a version drops its download and its notification`() = runBlocking {
        releases = listOf(UpdateFixtures.withApkPayload(v060, apk), v0511)
        val m = manager("0.5.11")
        m.backgroundCycle()
        assertEquals(1, notifications.allNotifications.size)
        val path = m.state.value.downloadedPath!!

        m.skip()
        assertEquals(UpdatePhase.UP_TO_DATE, m.state.value.phase)
        assertFalse(File(path).exists())
        assertEquals(0, notifications.allNotifications.size)
        m.awaitReadyVersion(null)
        assertEquals("0.6.0", SettingsStore(app).get().updateSkippedVersion)
        // The skipped version stays quiet; a check finds nothing to offer.
        assertEquals(UpdatePhase.UP_TO_DATE, m.backgroundCycle().phase)
        assertEquals(0, notifications.allNotifications.size)
        assertEquals(0, installs())
    }

    // ---- the install permission ----------------------------------------------------------------

    @Test
    fun `without the install permission the tap asks for it, and the grant alone starts nothing`() = runBlocking {
        shadowOf(app.packageManager).setCanRequestPackageInstalls(false)
        releases = listOf(UpdateFixtures.withApkPayload(v060, apk), v0511)
        val m = manager("0.5.11")
        assertTrue(m.state.value.needsInstallPermission)

        m.check(manual = false)
        val ready = m.awaitPhase(UpdatePhase.READY, UpdatePhase.ERROR)
        assertEquals(ready.error, UpdatePhase.READY, ready.phase)
        assertTrue("the file is verified and waiting", ready.canInstall)

        assertFalse(m.install())
        assertTrue(m.state.value.needsInstallPermission)
        assertEquals(UpdatePhase.READY, m.state.value.phase)
        delay(200)
        assertEquals(0, installs())

        // Back from "Allow from this source": the screen offers Install, and only the tap proceeds.
        shadowOf(app.packageManager).setCanRequestPackageInstalls(true)
        m.onAppVisible()
        assertFalse(m.state.value.needsInstallPermission)
        delay(300)
        assertEquals("a granted permission is not a tap", 0, installs())
        assertEquals(UpdatePhase.READY, m.state.value.phase)

        assertTrue(m.install())
        assertEquals("0.6.0", awaitInstall().second)
        assertEquals(1, installs())
    }
}
