package app.murmur.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.inference.InferenceRouting
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.AppShell
import app.murmur.android.ui.HomeScreen
import app.murmur.android.ui.InferenceView
import app.murmur.android.ui.KeyboardScreen
import app.murmur.android.ui.LocalInferenceView
import app.murmur.android.ui.Navigator
import app.murmur.android.ui.Route
import app.murmur.android.ui.Section
import app.murmur.android.ui.components.Glyph
import app.murmur.android.ui.theme.Layout
import app.murmur.android.ui.theme.MurmurTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.io.FileOutputStream

/**
 * The app on a tablet (the expanded width class, 1280 x 800 dp): the drawer stays open as a rail,
 * the menu button goes away, and every screen's content is capped at a reading width and centred
 * in the space beside the rail. The frames are written out (build/reports/pill-screenshots).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1280dp-h800dp-land-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TabletLayoutTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private lateinit var navigator: Navigator
    private lateinit var store: SettingsStore

    private val sections = listOf(
        Section(Route.HOME, "Home", Glyph.HOME),
        Section(Route.HISTORY, "History", Glyph.HISTORY),
        Section(Route.BUTTON, "Dictation button", Glyph.BUTTON, group = "Setup"),
        Section(Route.KEYBOARD, "Keyboard", Glyph.KEYBOARD),
        Section(Route.MODEL, "Speech model", Glyph.MODEL)
    )

    private val ready = InferenceView(
        cloudEnabled = false, managedAvailable = false,
        routing = InferenceRouting(InferenceSource.CUSTOM, InferenceSource.CUSTOM),
        signedIn = false, status = null, plan = "free", planState = "free", trialDaysLeft = 0,
        sttReady = true, llmReady = true
    )

    @Before
    fun setUp() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        store = SettingsStore(context)
        navigator = Navigator(listOf(Route.HOME))
        compose.setContent {
            val settings by store.flow.collectAsState()
            MurmurTheme(settings.copy(dynamicColor = false)) {
                CompositionLocalProvider(LocalInferenceView provides ready) {
                    AppShell(navigator, sections, footer = { Text("Murmur ${BuildConfig.VERSION_NAME}") }) { entry, nav ->
                        when (entry.route) {
                            Route.KEYBOARD -> KeyboardScreen(store, settings, nav)
                            else -> HomeScreen(
                                CloudConfig.OFF, settings, signedIn = false, firstName = "Bennett", syncStatus = null,
                                nav = nav, onOpen = navigator::open, howTo = "hold Ctrl + Meta to dictate"
                            )
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun `the drawer is a rail, the menu button is gone, and the content is capped and centred`() {
        compose.onNodeWithTag("drawer").assertIsDisplayed()
        compose.onNodeWithText("Dictation button").assertIsDisplayed()
        compose.onNodeWithContentDescription("Sections").assertDoesNotExist()
        // Home: the greeting sits beside the rail, inside the capped column.
        val rail = compose.onNodeWithTag("drawer").getBoundsInRoot()
        assertEquals(Layout.rail, rail.width)
        val greeting = compose.onAllNodesWithText(", Bennett.", substring = true)[0].getBoundsInRoot()
        val contentLeft = rail.right + (1280.dp - rail.right - Layout.contentMaxWidth) / 2
        assertTrue("greeting starts at ${greeting.left}, content column at $contentLeft", (greeting.left - contentLeft - 24.dp).value in -2f..2f)
        save("tablet-home.png")

        // Keyboard: chosen from the rail, still no menu button, the heading in the same column.
        compose.onNodeWithText("Keyboard").performClick()
        compose.waitForIdle()
        assertEquals(listOf(Route.HOME, Route.KEYBOARD), navigator.stack)
        compose.onNodeWithContentDescription("Sections").assertDoesNotExist()
        compose.onNodeWithText("Push to talk").assertIsDisplayed()
        val heading = compose.onAllNodesWithText("Keyboard")[1].getBoundsInRoot()
        assertTrue("heading starts at ${heading.left}", (heading.left - contentLeft - 24.dp).value in -2f..2f)
        val description = compose.onAllNodesWithText("With a keyboard attached", substring = true)[0].getBoundsInRoot()
        assertTrue("description is ${description.width} wide", description.width <= Layout.contentMaxWidth - 48.dp + 1.dp)
        save("tablet-keyboard.png")
    }

    /** Draw the activity's window as the user would see it. */
    private fun save(name: String) {
        val dir = System.getProperty("murmur.screenshotDir")?.takeIf { it.isNotBlank() }?.let(::File) ?: return
        dir.mkdirs()
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width.coerceAtLeast(1), decor.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { decor.draw(Canvas(bitmap)) }
        FileOutputStream(File(dir, name)).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
