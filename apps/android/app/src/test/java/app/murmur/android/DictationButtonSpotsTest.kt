package app.murmur.android

import android.content.Context
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.DictationButtonScreen
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.theme.MurmurTheme
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
import org.robolectric.shadows.ShadowBuild

private const val CORNER = "Bottom-left corner, over the keyboard"
private const val CENTRED = "Centred, 25 dp above the keyboard"
private const val CORNER_NUMBERS = "11% from the left, 323 dp down over the keyboard"
private const val SHADOW = "Button shadow"

/**
 * The Dictation button screen. Its Spots list: untouched default spots read in plain words, a
 * spot the user moved reads by its numbers, and Reset brings the words back. Its Look group: the
 * Button shadow switch sits between Shape and Spots and flips the setting in the store. On a
 * Galaxy S26 Ultra (pinned spots) at its out-of-the-box 384 x 832 dp.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DictationButtonSpotsTest {

    @get:Rule
    val compose = createComposeRule()

    private lateinit var store: SettingsStore

    @Before
    fun setUp() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        ShadowBuild.setModel("SM-S948B")
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
    fun `untouched default spots read in plain words`() {
        compose.onNodeWithText(CORNER).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(CENTRED).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(CORNER_NUMBERS).assertDoesNotExist()
        compose.onNodeWithText("rests here").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun `a moved spot reads by its numbers, and Reset brings the words back`() {
        store.update { it.copy(overlayLayout = it.overlayLayout.moved(0, OverlayAnchor(0.11f, -300f))) }
        compose.waitForIdle()
        compose.onNodeWithText("11% from the left, 300 dp down over the keyboard").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(CORNER).assertDoesNotExist()
        // The other spot was left alone and still reads as it did.
        compose.onNodeWithText(CENTRED).performScrollTo().assertIsDisplayed()

        compose.onNodeWithText("Reset").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText(CORNER).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("11% from the left, 300 dp down over the keyboard").assertDoesNotExist()
    }

    @Test
    fun `moving the centred spot leaves the corner spot's words alone`() {
        store.update { it.copy(overlayLayout = it.overlayLayout.moved(1, OverlayAnchor(0.5f, 40f))) }
        compose.waitForIdle()
        compose.onNodeWithText(CORNER).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Centred, 40 dp above the keyboard").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(CENTRED).assertDoesNotExist()
    }

    @Test
    fun `the Button shadow switch sits in the Look group, between Shape and Spots`() {
        // Group labels are overlines, drawn in capitals.
        compose.onNodeWithText("LOOK").performScrollTo().assertIsDisplayed()
        val shape = compose.onNodeWithText("SHAPE").fetchSemanticsNode().boundsInRoot.top
        val look = compose.onNodeWithText("LOOK").fetchSemanticsNode().boundsInRoot.top
        val spots = compose.onNodeWithText("SPOTS").fetchSemanticsNode().boundsInRoot.top
        assertTrue("Look comes after Shape", shape < look)
        assertTrue("Look comes before Spots", look < spots)
        val row = compose.onNodeWithText(SHADOW).performScrollTo().assertIsDisplayed()
        val label = compose.onNodeWithText(SHADOW).fetchSemanticsNode().boundsInRoot.top
        assertTrue("the switch is the Look group's row", look < label && label < spots)
        row.assertIsOn()
    }

    @Test
    fun `flipping the Button shadow switch writes the setting and reads it back`() {
        assertTrue(store.get().buttonShadow)
        compose.onNodeWithText(SHADOW).performScrollTo().assertIsOn().performClick()
        compose.waitForIdle()
        assertFalse(store.get().buttonShadow)
        compose.onNodeWithText(SHADOW).assertIsOff()

        compose.onNodeWithText(SHADOW).performClick()
        compose.waitForIdle()
        assertTrue(store.get().buttonShadow)
        compose.onNodeWithText(SHADOW).assertIsOn()
    }
}
