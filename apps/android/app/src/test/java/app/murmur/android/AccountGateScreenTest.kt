package app.murmur.android

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.ui.AccountGate
import app.murmur.android.ui.theme.MurmurTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The account gate around Clerk's sign-in form. Clerk's `AuthView` is a Material3 Scaffold, and
 * a Scaffold fills whatever height it is given: measured inside the gate's scrolling column with
 * no bound, Compose refused the layout (`Size(w x 2147483647) is out of range`) and the 0.6.0
 * app died the moment Clerk was ready, on every launch. The form stands in for Clerk's here with
 * the same kind of Scaffold, so the layout is checked without Clerk or the network.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AccountGateScreenTest {

    @get:Rule
    val compose = createComposeRule()

    private val optional = CloudConfig.resolve("https://a.convex.cloud", "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k", "optional")
    private val required = CloudConfig.resolve("https://a.convex.cloud", "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k", "")

    /** What Clerk's AuthView is at the layout level: a Scaffold that fills the height it is given. */
    @Composable
    private fun ScaffoldForm() {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            topBar = { Box(Modifier.fillMaxWidth().height(64.dp)) }
        ) { padding ->
            Column(Modifier.padding(padding)) {
                Text("Continue to Murmur")
                Text("Enter your email")
            }
        }
    }

    private fun show(
        config: CloudConfig,
        ready: Boolean,
        error: String? = null,
        timeoutMs: Long = 20_000,
        onRetry: () -> Unit = {},
        onSkip: () -> Unit = {}
    ) {
        compose.setContent {
            MurmurTheme(MurmurSettings(dynamicColor = false)) {
                AccountGate(config, ready, error, onRetry, onSkip, readyTimeoutMs = timeoutMs) { ScaffoldForm() }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun clerkScaffoldLaysOutInsideTheScrollingGate() {
        show(optional, ready = true)
        compose.onNodeWithText("Continue to Murmur").assertExists()
        compose.onNodeWithText("Enter your email").assertExists()
        // The form got a real, finite height: at least the minimum the gate promises it.
        val form = compose.onNodeWithTag("account-gate-form").fetchSemanticsNode()
        val heightDp = form.size.height / form.layoutInfo.density.density
        assertTrue("form height should be finite and at least 360 dp, was $heightDp", heightDp >= 360f && heightDp < 100_000f)
        // Optional mode keeps its way past the form.
        compose.onNodeWithText("Continue without an account").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun requiredModeShowsNoSkipWhileTheFormIsUp() {
        show(required, ready = true)
        compose.onNodeWithText("Continue to Murmur").assertExists()
        assertEquals(0, compose.onAllNodesWithTag("account-gate-trouble").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("Continue without an account").fetchSemanticsNodes().size)
    }

    @Test
    fun connectingTurnsIntoTroubleAfterTheTimeout() {
        var skipped = false
        show(required, ready = false, timeoutMs = 200, onSkip = { skipped = true })
        compose.onNodeWithTag("account-gate-connecting").assertExists()
        compose.waitUntil(timeoutMillis = 10_000) {
            compose.onAllNodesWithTag("account-gate-trouble").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Couldn't connect to Murmur's server").assertExists()
        // Even a required-account build lets the user carry on when sign-in cannot be reached.
        compose.onNodeWithText("Continue without an account").performScrollTo().performClick()
        assertTrue(skipped)
    }

    @Test
    fun clerkErrorShowsTroubleWithRetry() {
        var retried = 0
        show(required, ready = false, error = "IllegalStateException: environment unavailable", onRetry = { retried++ })
        compose.onNodeWithTag("account-gate-trouble").assertExists()
        compose.onNodeWithText("IllegalStateException: environment unavailable").assertExists()
        compose.onNodeWithText("Try again").performScrollTo().performClick()
        assertEquals(1, retried)
        compose.onNodeWithText("Continue without an account").assertExists()
    }
}
