package app.murmur.android

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import app.murmur.android.settings.SettingsStore
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
    }

    @After
    fun stop() = server.shutdown()

    private fun manager(currentVersion: String, autoInstall: Boolean = true): UpdateManager {
        val settings = SettingsStore(app)
        settings.update { it.copy(updateAutoInstall = autoInstall) }
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

    private fun requested(suffix: String): Int = synchronized(requests) { requests.count { it.endsWith(suffix) } }

    private fun pendingPrefs(): Pair<String?, String?> =
        app.getSharedPreferences("murmur_updater", Context.MODE_PRIVATE).let { it.getString("pendingVersion", null) to it.getString("pendingFrom", null) }

    private fun installsFromDigest(fixture: JsonObject, tag: String, from: String, others: List<JsonObject>) = runBlocking {
        releases = listOf(UpdateFixtures.withApkPayload(fixture, apk)) + others
        val m = manager(from)

        val found = m.check(manual = false)
        // The check kicks the download off before it returns; the state may already be past AVAILABLE.
        assertTrue(found.error, found.phase in setOf(UpdatePhase.AVAILABLE, UpdatePhase.DOWNLOADING, UpdatePhase.READY, UpdatePhase.INSTALLING))
        assertEquals(tag.removePrefix("v"), found.release?.version)
        assertEquals("Murmur-${tag.removePrefix("v")}-android.apk", found.release?.apk?.name)
        assertEquals(UpdateFixtures.sha256Hex(apk), found.release?.sha256)
        assertNull(found.release?.checksumProblem)

        // "Install automatically" is on: download, verify, hand to the installer once idle.
        val installing = m.awaitPhase(UpdatePhase.INSTALLING, UpdatePhase.ERROR)
        assertEquals(installing.error, UpdatePhase.INSTALLING, installing.phase)
        val (file, version) = awaitInstall()
        assertEquals(tag.removePrefix("v"), version)
        assertEquals("Murmur-${tag.removePrefix("v")}-android.apk", file.name)
        assertEquals(UpdateFixtures.sha256Hex(apk), UpdateFixtures.sha256Hex(file.readBytes()))
        assertEquals(tag.removePrefix("v") to from, pendingPrefs())

        // The digest came with the release JSON: the checksum file was never needed.
        assertEquals(0, requested("SHA256SUMS.txt"))
        assertEquals(1, requested("-android.apk"))
    }

    @Test
    fun `a 0-5-11 phone verifies v0-6-0 against the release's asset digest and installs it`() =
        installsFromDigest(v060, "v0.6.0", from = "0.5.11", others = listOf(v0511))

    /** The feed as a 0.5.10 phone saw it before v0.6.0 existed. */
    @Test
    fun `a 0-5-10 phone verifies v0-5-11 the same way`() =
        installsFromDigest(v0511, "v0.5.11", from = "0.5.10", others = emptyList())

    @Test
    fun `a release whose assets carry no digest is verified against its SHA256SUMS txt`() = runBlocking {
        releases = listOf(UpdateFixtures.withoutDigests(UpdateFixtures.withApkPayload(v060, apk)), v0511)
        val m = manager("0.5.11")
        val found = m.check(manual = false)
        assertTrue(found.error, found.phase != UpdatePhase.ERROR)
        assertEquals(UpdateFixtures.sha256Hex(apk), found.release?.sha256)
        assertEquals(1, requested("SHA256SUMS.txt"))
        assertEquals(UpdatePhase.INSTALLING, m.awaitPhase(UpdatePhase.INSTALLING, UpdatePhase.ERROR).phase)
        assertEquals("0.6.0", awaitInstall().second)
    }

    @Test
    fun `a checksum file that cannot be downloaded is a retried download error, not a release without checksums`() = runBlocking {
        releases = listOf(UpdateFixtures.withoutDigests(UpdateFixtures.withApkPayload(v060, apk)), v0511)
        sumsStatus = 503
        val m = manager("0.5.11")

        val failed = m.check(manual = false)
        assertEquals(UpdatePhase.ERROR, failed.phase)
        assertTrue(failed.error, failed.error!!.contains("Could not download SHA256SUMS.txt for Murmur 0.6.0"))
        assertTrue(failed.error, failed.error!!.contains("HTTP 503"))
        assertFalse(failed.error, failed.error!!.contains("ships no"))
        assertNull(failed.release)
        assertFalse(failed.canInstall)
        // Three attempts at the small file, and no APK: nothing could have verified it.
        assertEquals(3, requested("SHA256SUMS.txt"))
        delay(200)
        assertEquals(0, requested("-android.apk"))
        assertTrue(synchronized(installed) { installed.isEmpty() })

        // GitHub is back: the next check picks the update up and installs it.
        sumsStatus = 200
        val found = m.check(manual = false)
        assertTrue(found.error, found.phase != UpdatePhase.ERROR)
        assertEquals(UpdateFixtures.sha256Hex(apk), found.release?.sha256)
        assertEquals(UpdatePhase.INSTALLING, m.awaitPhase(UpdatePhase.INSTALLING, UpdatePhase.ERROR).phase)
        assertEquals("0.6.0", awaitInstall().second)
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
        val failed = m.awaitPhase(UpdatePhase.ERROR, UpdatePhase.READY, UpdatePhase.INSTALLING)
        assertEquals(UpdatePhase.ERROR, failed.phase)
        assertTrue(failed.error, failed.error!!.contains("did not match the release checksum"))
        assertNull(failed.downloadedPath)
        assertEquals(emptyList<String>(), File(app.cacheDir, "updates").listFiles()?.map { it.name } ?: emptyList<String>())
        delay(100)
        assertTrue(synchronized(installed) { installed.isEmpty() })
    }

    @Test
    fun `a re-check keeps a verified download only while the checksum is unchanged`() = runBlocking {
        releases = listOf(UpdateFixtures.withApkPayload(v060, apk), v0511)
        val m = manager("0.5.11", autoInstall = false)
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
    }

    @Test
    fun `a failed check is retried after an hour, a good one after a day`() {
        assertEquals(60L * 60 * 1000, UpdateManager.nextCheckInterval(UpdatePhase.ERROR))
        assertEquals(24L * 60 * 60 * 1000, UpdateManager.nextCheckInterval(UpdatePhase.UP_TO_DATE))
        assertEquals(24L * 60 * 60 * 1000, UpdateManager.nextCheckInterval(UpdatePhase.READY))
    }
}
