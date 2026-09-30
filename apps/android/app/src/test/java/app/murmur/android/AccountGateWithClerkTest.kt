package app.murmur.android

import android.os.Looper
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.ui.AccountGateScreen
import app.murmur.android.ui.theme.MurmurTheme
import com.clerk.api.Clerk
import com.clerk.api.ClerkConfigurationOptions
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The real account gate with the real Clerk SDK and its real sign-in form, without a network:
 * Clerk is pointed (`proxyUrl`) at a MockWebServer that answers `/v1/environment` and `/v1/client`
 * with the shape of the production instance (email code and Google, password required; see
 * src/test/resources/clerk). The 0.6.0 build died on the first frame that showed this form, because
 * Clerk's AuthView (a Material3 Scaffold) was measured without a height bound inside the gate's
 * scrolling column; nothing had ever composed the two together before a device did. This test
 * does, in the two parents that matter: the window (bounded) and a scroller (unbounded), in both
 * account modes. AccountGateScreenTest checks the gate's own states with a stand-in form.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AccountGateWithClerkTest {

    @get:Rule
    val compose = createComposeRule()

    private val server = MockWebServer()

    private val optional = CloudConfig.resolve("https://a.convex.cloud", TEST_KEY, "optional")
    private val required = CloudConfig.resolve("https://a.convex.cloud", TEST_KEY, "")

    /** Clerk's Frontend API, as far as initialisation and the start screen go. */
    private inner class FrontendApi : Dispatcher() {
        val unexpected = mutableListOf<String>()

        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.path ?: ""
            return when {
                path.startsWith("/v1/environment") -> json(fixture("environment.json").replace("https://img.clerk.com", server.url("/img").toString().trimEnd('/')))
                path.startsWith("/v1/client") -> json(fixture("client.json"))
                path.startsWith("/img/") -> MockResponse().setResponseCode(404)
                else -> {
                    unexpected += "${request.method} $path"
                    MockResponse().setResponseCode(404)
                }
            }
        }

        private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    }

    private val api = FrontendApi()

    private fun fixture(name: String): String =
        checkNotNull(javaClass.getResourceAsStream("/clerk/$name")) { "missing test resource clerk/$name" }
            .bufferedReader().use { it.readText() }

    @Before
    fun clerk() {
        server.dispatcher = api
        server.start()
        // Clerk is a process-wide singleton: the first test in the JVM initialises it against this
        // server; later ones find it ready (its state is in memory) and only compose.
        if (!Clerk.isInitialized.value) {
            Clerk.initialize(
                ApplicationProvider.getApplicationContext(),
                publishableKey = TEST_KEY,
                options = ClerkConfigurationOptions(
                    proxyUrl = server.url("/").toString().trimEnd('/'),
                    telemetryEnabled = false
                )
            )
        }
        var waited = 0L
        while (waited < 30_000 && !Clerk.isInitialized.value && Clerk.initializationError.value == null) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(50)
            waited += 50
        }
        assertNull("Clerk failed to initialise against the fixture server", Clerk.initializationError.value)
        assertTrue("Clerk did not initialise within 30 s (unexpected requests: ${api.unexpected})", Clerk.isInitialized.value)
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun show(content: @Composable () -> Unit) {
        compose.setContent { MurmurTheme(MurmurSettings(dynamicColor = false)) { content() } }
        compose.waitForIdle()
        compose.waitUntil(timeoutMillis = 10_000) {
            compose.onAllNodesWithTag("account-gate-form").fetchSemanticsNodes().isNotEmpty()
        }
        compose.waitForIdle()
    }

    /** Clerk's start screen for this instance, laid out with a real height; returns that height in dp. */
    private fun assertClerkFormLaidOut(): Float {
        compose.onNodeWithText("Enter your email").assertExists()
        compose.onNodeWithText("Continue").assertExists()
        compose.onNodeWithText("Continue with Google").assertExists()
        val form = compose.onNodeWithTag("account-gate-form").fetchSemanticsNode()
        val heightDp = form.size.height / form.layoutInfo.density.density
        assertTrue("the form should have a finite height of at least 360 dp, had $heightDp", heightDp >= 360f && heightDp < 100_000f)
        if (api.unexpected.isNotEmpty()) fail("Clerk asked the fixture server for something it does not serve: ${api.unexpected}")
        return heightDp
    }

    @Test
    @Config(qualifiers = "w412dp-h915dp-420dpi")
    fun clerkFormLaysOutInsideTheGateInABoundedParent() {
        // A phone-sized window, as the activity gives the gate: the form takes the leftover height.
        show { Box(Modifier.fillMaxSize()) { AccountGateScreen(optional, onSkip = {}) } }
        val height = assertClerkFormLaidOut()
        assertTrue("on a 915 dp window the form should take the leftover height, had $height dp", height >= 500f)
        compose.onNodeWithText("Continue without an account").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun clerkFormLaysOutInsideTheGateInAnUnboundedParent() {
        // The gate itself measured with no height bound, in the default 470 dp window: the form
        // falls back to its minimum and the parent does the scrolling.
        show { Column(Modifier.verticalScroll(rememberScrollState())) { AccountGateScreen(required, onSkip = {}) } }
        assertEquals(360f, assertClerkFormLaidOut(), 1f)
        assertEquals(0, compose.onAllNodesWithText("Continue without an account").fetchSemanticsNodes().size)
    }

    private companion object {
        /** Decodes to `clerk.example.com`; with `proxyUrl` set Clerk never derives a host from it. */
        const val TEST_KEY = "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k"
    }
}
