package app.murmur.android

import android.content.Context
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.AppearanceScreen
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.theme.MurmurTheme
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Appearance screen holds the theme, the palette and the accent, and nothing about the
 * dictation button itself: its Button shadow switch lives on the Dictation button screen, and
 * this screen ends with a line that says so.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AppearanceScreenTest {

    @get:Rule
    val compose = createComposeRule()

    @Before
    fun setUp() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        val store = SettingsStore(context)
        compose.setContent {
            val settings by store.flow.collectAsState()
            MurmurTheme(settings.copy(dynamicColor = false)) {
                AppearanceScreen(store, settings, TopNav.Back {})
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun `the button's shadow is not set here, and a line points to the Dictation button screen`() {
        compose.onNodeWithText("THEME").assertIsDisplayed()
        compose.onNodeWithText("ACCENT").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Button shadow").assertDoesNotExist()
        compose.onNodeWithText("DICTATION BUTTON").assertDoesNotExist()
        compose.onNodeWithText("Shape and shadow for the button itself are under Dictation button.")
            .performScrollTo()
            .assertIsDisplayed()
    }
}
