package app.murmur.android

import android.content.Context
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.DictationButtonScreen
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.theme.MurmurTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Feedback group on the Dictation button screen: Sounds (with its volume while on) and
 * Haptics, the desktop's sounds and volume settings, written to the store.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FeedbackSettingsTest {

    @get:Rule
    val compose = createComposeRule()

    private lateinit var store: SettingsStore

    @Before
    fun setUp() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        store = SettingsStore(context)
        compose.setContent {
            val settings by store.flow.collectAsState()
            MurmurTheme(settings.copy(dynamicColor = false)) {
                DictationButtonScreen(store, settings, TopNav.Back {})
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun `sounds and haptics start on, and turning sounds off hides the volume`() {
        compose.onNodeWithText("FEEDBACK").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Sounds").performScrollTo().assertIsOn()
        compose.onNodeWithTag("soundVolume").performScrollTo().assertIsDisplayed()
        assertTrue(store.get().sounds)
        assertEquals(0.35f, store.get().soundVolume)

        compose.onNodeWithText("Sounds").performClick()
        compose.waitForIdle()
        assertFalse(store.get().sounds)
        compose.onNodeWithText("Sounds").assertIsOff()
        compose.onNodeWithTag("soundVolume").assertDoesNotExist()

        compose.onNodeWithText("Haptics").performScrollTo().assertIsOn().performClick()
        compose.waitForIdle()
        assertFalse(store.get().haptics)
    }
}
