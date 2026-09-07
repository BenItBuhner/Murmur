package app.murmur.android

import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.ui.AppShell
import app.murmur.android.ui.Navigator
import app.murmur.android.ui.Route
import app.murmur.android.ui.Section
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.TopNavButton
import app.murmur.android.ui.components.Glyph
import app.murmur.android.ui.theme.MurmurTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The frame around the app: the button at the top left opens the drawer, a section chosen there
 * replaces what is on screen and still wears the menu button, back leads home, and while the
 * drawer is open back closes it instead of popping anything.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AppShellTest {

    @get:Rule
    val compose = createComposeRule()

    private lateinit var navigator: Navigator
    private lateinit var dispatcher: OnBackPressedDispatcher

    private val sections = listOf(
        Section(Route.HOME, "Home", Glyph.HOME),
        Section(Route.HISTORY, "History", Glyph.HISTORY),
        Section(Route.STYLE, "Style", Glyph.STYLE, group = "Personalize", attention = true)
    )

    private fun show() {
        navigator = Navigator(listOf(Route.HOME))
        compose.setContent {
            dispatcher = LocalOnBackPressedDispatcherOwner.current!!.onBackPressedDispatcher
            MurmurTheme(MurmurSettings(dynamicColor = false)) {
                AppShell(navigator, sections, footer = { Text("Footer") }) { entry, nav ->
                    Column {
                        TopNavButton(nav)
                        Text("Screen ${entry.route.name}")
                        Text(if (nav is TopNav.Menu) "menu" else "back")
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun `home shows the menu button and the drawer starts closed`() {
        show()
        compose.onNodeWithText("Screen HOME").assertIsDisplayed()
        compose.onNodeWithText("menu").assertIsDisplayed()
        compose.onNodeWithContentDescription("Sections").assertIsDisplayed()
        compose.onNodeWithText("History").assertIsNotDisplayed()
    }

    @Test
    fun `the menu button opens the drawer and picking a section shows it, still top level`() {
        show()
        compose.onNodeWithContentDescription("Sections").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("drawer").assertIsDisplayed()
        compose.onNodeWithText("History").assertIsDisplayed()
        compose.onNodeWithText("PERSONALIZE").assertIsDisplayed()
        compose.onNodeWithText("Footer").assertIsDisplayed()

        compose.onNodeWithText("History").performClick()
        compose.waitForIdle()

        assertEquals(listOf(Route.HOME, Route.HISTORY), navigator.stack)
        assertTrue(navigator.lateral)
        compose.onNodeWithText("Screen HISTORY").assertIsDisplayed()
        compose.onNodeWithText("menu").assertIsDisplayed()
        compose.onNodeWithText("Screen HOME").assertDoesNotExist()
        // The drawer went away with the choice.
        compose.onNodeWithText("PERSONALIZE").assertIsNotDisplayed()
    }

    @Test
    fun `back from a section leads home`() {
        show()
        compose.onNodeWithContentDescription("Sections").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Style").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Screen STYLE").assertIsDisplayed()

        compose.runOnUiThread { dispatcher.onBackPressed() }
        compose.waitForIdle()

        assertEquals(listOf(Route.HOME), navigator.stack)
        compose.onNodeWithText("Screen HOME").assertIsDisplayed()
        compose.onNodeWithText("Screen STYLE").assertDoesNotExist()
    }

    @Test
    fun `a pushed screen wears the back arrow, and the arrow pops it`() {
        show()
        compose.runOnUiThread { navigator.open(Route.STYLE) }
        compose.waitForIdle()
        compose.onNodeWithText("Screen STYLE").assertIsDisplayed()
        compose.onNodeWithText("back").assertIsDisplayed()

        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitForIdle()
        assertEquals(listOf(Route.HOME), navigator.stack)
        compose.onNodeWithText("Screen HOME").assertIsDisplayed()
    }

    @Test
    fun `while the drawer is open, back closes it and leaves the stack alone`() {
        show()
        compose.runOnUiThread { navigator.select(Route.HISTORY) }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Sections").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Home").assertIsDisplayed()

        compose.runOnUiThread { dispatcher.onBackPressed() }
        compose.waitForIdle()

        assertEquals(listOf(Route.HOME, Route.HISTORY), navigator.stack)
        compose.onNodeWithText("Screen HISTORY").assertIsDisplayed()
        compose.onNodeWithText("PERSONALIZE").assertIsNotDisplayed()
        assertFalse(navigator.stack.size == 1)
    }
}
