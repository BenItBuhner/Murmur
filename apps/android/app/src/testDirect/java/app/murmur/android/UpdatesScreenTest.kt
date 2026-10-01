package app.murmur.android

import android.app.Application
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.UpdatesSection
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.theme.MurmurTheme
import app.murmur.android.update.UpdateManager
import app.murmur.android.update.UpdatePhase
import app.murmur.android.update.UpdateSource
import java.io.File
import java.net.InetAddress
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Updates screen of the direct flavor, drawn for real: its Install button is the one thing in
 * the app that hands a verified download to the package installer, and its preferences row is
 * about downloading, not installing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UpdatesScreenTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val server = MockWebServer()
    private lateinit var app: Application
    private lateinit var store: SettingsStore
    private val apk = ByteArray(50_000) { (it * 13).toByte() }
    private val installed = mutableListOf<Pair<File, String>>()

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        app.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        app.getSharedPreferences("murmur_updater", Context.MODE_PRIVATE).edit().clear().commit()
        shadowOf(app.packageManager).setCanRequestPackageInstalls(true)
        store = SettingsStore(app)
        store.update { it.copy(updateAutoCheck = false) }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val origin = "http://127.0.0.1:${server.port}"
        val release = UpdateFixtures.withApkPayload(UpdateFixtures.parse(UpdateFixtures.releaseJson("v0.6.0")), apk)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    path.startsWith("/repos/") -> MockResponse().setHeader("Content-Type", "application/json").setBody(UpdateFixtures.listBody(origin, release))
                    path.endsWith("-android.apk") -> MockResponse().setBody(Buffer().write(apk))
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    @After
    fun tearDown() = server.shutdown()

    private fun readyManager(): UpdateManager {
        val origin = "http://127.0.0.1:${server.port}"
        val m = UpdateManager(app, store, UpdateSource(UpdateFixtures.REPO, "0.5.11", origin, origin))
        m.commitInstall = { file, version -> synchronized(installed) { installed += file to version } }
        runBlocking {
            m.check(manual = true)
            withTimeout(20_000) { m.state.first { it.phase == UpdatePhase.READY } }
        }
        return m
    }

    /** The section inside the screen chrome, laid out as UpdatesScreen lays it out. */
    private fun show(manager: UpdateManager) {
        compose.setContent {
            val settings by store.flow.collectAsState()
            MurmurTheme(settings.copy(dynamicColor = false)) {
                Screen(title = "Updates", nav = TopNav.None) { UpdatesSection(store, settings, manager) }
            }
        }
    }

    @Test
    fun `a verified download waits on the screen until Install is tapped`() {
        val m = readyManager()
        show(m)
        compose.onNodeWithText("Murmur 0.6.0 is ready to install").assertIsDisplayed()
        compose.onNodeWithText("Install").assertIsDisplayed()
        assertTrue("drawn, not installed", installed.isEmpty())
        assertEquals(UpdatePhase.READY, m.state.value.phase)

        compose.onNodeWithText("Install").performScrollTo().performClick()
        compose.waitUntil(10_000) { synchronized(installed) { installed.size == 1 } }
        assertEquals("0.6.0", installed.single().second)
        compose.onNodeWithText("Installing Murmur 0.6.0…").assertIsDisplayed()
    }

    @Test
    fun `the preference is about downloading, and installing is described as the user's tap`() {
        val m = readyManager()
        show(m)
        compose.onNodeWithText("Install automatically").assertDoesNotExist()
        compose.onNodeWithText("Download updates automatically").assertIsDisplayed()
        compose.onNodeWithText("Fetches new versions in the background and lets you know when one is ready. Nothing installs until you tap Install here.").assertIsDisplayed()
        assertTrue(store.get().updateAutoDownload)
        compose.onNodeWithText("Download updates automatically").performScrollTo().performClick()
        compose.waitForIdle()
        assertFalse(store.get().updateAutoDownload)
        assertTrue("toggling a preference installs nothing", installed.isEmpty())
    }
}
