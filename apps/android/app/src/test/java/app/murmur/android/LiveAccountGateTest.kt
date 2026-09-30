package app.murmur.android

import android.os.Looper
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.ui.AccountGateScreen
import app.murmur.android.ui.theme.MurmurTheme
import com.clerk.api.Clerk
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The real Clerk SDK against a real instance, inside the real account gate: Clerk initialises
 * from the publishable key (two GETs to its Frontend API, nothing is created but an anonymous
 * client record) and its sign-in form composes inside the gate's scrolling column, the layout that
 * took 0.6.0 down. Opt in with the instance's key:
 *
 *   MURMUR_LIVE=1 MURMUR_CLERK_PUBLISHABLE_KEY=pk_live_... ./gradlew :app:testDebugUnitTest \
 *     --tests app.murmur.android.LiveAccountGateTest
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LiveAccountGateTest {
    @get:Rule
    val compose = createComposeRule()

    private fun env(name: String): String = System.getenv(name) ?: ""

    private val key = env("MURMUR_CLERK_PUBLISHABLE_KEY")

    @Before
    fun live() {
        assumeTrue("Set MURMUR_LIVE=1 to run", env("MURMUR_LIVE") == "1")
        assumeTrue("Set MURMUR_CLERK_PUBLISHABLE_KEY", key.startsWith("pk_"))
    }

    @Test
    fun clerkSignsInInsideTheGate() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val config = CloudConfig.resolve("https://live.convex.cloud", key, "optional")
        assumeTrue(config.enabled)

        Clerk.initialize(app, publishableKey = config.clerkPublishableKey)
        var waited = 0L
        while (waited < 45_000 && !Clerk.isInitialized.value && Clerk.initializationError.value == null) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(200)
            waited += 200
        }
        assertNull("Clerk could not initialise", Clerk.initializationError.value)
        assertTrue("Clerk did not initialise within 45 s", Clerk.isInitialized.value)

        compose.setContent {
            MurmurTheme(MurmurSettings(dynamicColor = false)) {
                AccountGateScreen(config, onSkip = {})
            }
        }
        compose.waitForIdle()
        compose.waitUntil(timeoutMillis = 10_000) {
            compose.onAllNodesWithTag("account-gate-form").fetchSemanticsNodes().isNotEmpty()
        }
        // Clerk's start screen: the identifier field and its call to action, and the way past it.
        compose.onNodeWithText("Enter your email").assertExists()
        compose.onNodeWithText("Continue").assertExists()
        compose.onNodeWithText("Continue without an account").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("account-gate-form").assertExists()
    }
}
