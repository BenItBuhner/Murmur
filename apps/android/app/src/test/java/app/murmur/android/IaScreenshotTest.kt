package app.murmur.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.inference.InferenceRouting
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.ThemeMode
import app.murmur.android.ui.AppShell
import app.murmur.android.ui.DrawerRow
import app.murmur.android.ui.HomeScreen
import app.murmur.android.ui.InferenceView
import app.murmur.android.ui.KeyboardScreen
import app.murmur.android.ui.LocalInferenceView
import app.murmur.android.ui.Navigator
import app.murmur.android.ui.Route
import app.murmur.android.ui.SettingsScreen
import app.murmur.android.ui.drawerSections
import app.murmur.android.ui.settingsEntries
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.MurmurTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
 * The phone's frame as the user sees it, in both modes: the drawer with its five sections and the
 * one account row at its foot over a dark scrim, the Settings screen, and a predictive back gesture
 * half-way through, the leaving page carried half a screen to the right with the page beneath
 * showing through. Each frame is written out (build/reports/pill-screenshots/ia) for the record.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class IaScreenshotTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private lateinit var navigator: Navigator
    private lateinit var dispatcher: OnBackPressedDispatcher
    private var dark by mutableStateOf(false)

    private val ready = InferenceView(
        cloudEnabled = true, managedAvailable = true,
        routing = InferenceRouting(InferenceSource.MURMUR, InferenceSource.MURMUR),
        signedIn = true, status = null, plan = "unlimited", planState = "unlimited", trialDaysLeft = 0,
        sttReady = true, llmReady = true
    )

    private val entries = settingsEntries(
        model = "Murmur's models · Fast", modelReady = true, language = "English",
        button = "Shape, position, sounds and haptics", keyboard = "Shortcuts with a keyboard attached",
        appearance = "Follows the system · coral", permissions = "All 3 allowed", permissionsGranted = true,
        updates = "Murmur ${BuildConfig.VERSION_NAME}", updateReady = false
    )

    private fun show() {
        val context: Context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        val store = SettingsStore(context)
        navigator = Navigator(listOf(Route.HOME))
        compose.setContent {
            dispatcher = LocalOnBackPressedDispatcherOwner.current!!.onBackPressedDispatcher
            val settings by store.flow.collectAsState()
            MurmurTheme(settings.copy(dynamicColor = false, themeMode = if (dark) ThemeMode.DARK else ThemeMode.LIGHT)) {
                CompositionLocalProvider(LocalInferenceView provides ready) {
                    AppShell(
                        navigator, drawerSections(settingsAttention = false),
                        footer = { select ->
                            DrawerRow(
                                label = "Bennett", hint = "bennett@example.com · Synced",
                                onClick = { select(Route.ACCOUNT) }, modifier = Modifier.testTag("drawer-account")
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(
                                "Murmur ${BuildConfig.VERSION_NAME}", style = Murmur.type.labelSmall, color = Murmur.colors.inkMuted,
                                modifier = Modifier.padding(start = 14.dp, bottom = 4.dp)
                            )
                        }
                    ) { entry, nav ->
                        when (entry.route) {
                            Route.SETTINGS -> SettingsScreen(entries, nav, onOpen = navigator::open)
                            Route.KEYBOARD -> KeyboardScreen(store, settings, nav)
                            else -> HomeScreen(
                                CloudConfig.OFF, settings, signedIn = true, firstName = "Bennett", syncStatus = null,
                                nav = nav, onOpen = navigator::open
                            )
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun event(progress: Float) =
        BackEventCompat(touchX = 40f + progress * 600f, touchY = 1200f, progress = progress, swipeEdge = BackEventCompat.EDGE_LEFT)

    @Test
    fun `the drawer lists five sections and one account row, with no Listening item`() {
        show()
        compose.onNodeWithContentDescription("Sections").performClick()
        compose.waitForIdle()
        for (label in listOf("Home", "History", "Dictionary and snippets", "Style", "Settings")) {
            compose.onNodeWithText(label).assertIsDisplayed()
        }
        assertEquals(1, compose.onAllNodesWithTag("drawer-account").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("Account", substring = true).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("Listening").fetchSemanticsNodes().size)
        for (gone in listOf("Speech model", "Language", "Dictation button", "Keyboard", "Appearance", "Permissions", "Updates", "Try it")) {
            assertEquals(gone, 0, compose.onAllNodesWithText(gone).fetchSemanticsNodes().size)
        }
        compose.onNodeWithContentDescription("Close navigation menu").assertIsDisplayed()
        save("android-drawer-after-light.png")
        dark = true
        compose.waitForIdle()
        save("android-drawer-after-dark.png")

        // The account row leads to the account; back leads home.
        compose.onNodeWithTag("drawer-account").performClick()
        compose.waitForIdle()
        assertEquals(listOf(Route.HOME, Route.ACCOUNT), navigator.stack)
        compose.onNodeWithText("History").assertIsNotDisplayed()
    }

    @Test
    fun `the Settings screen lists every page, and a back gesture carries a page half a screen to the right`() {
        show()
        compose.runOnUiThread { navigator.select(Route.SETTINGS) }
        compose.waitForIdle()
        for (label in listOf("Speech model", "Language", "Dictation button", "Keyboard", "Appearance", "Permissions", "Updates", "Try it")) {
            compose.onNodeWithText(label).assertIsDisplayed()
        }
        compose.onNodeWithContentDescription("Sections").assertIsDisplayed()
        save("android-settings-after-light.png")
        dark = true
        compose.waitForIdle()
        save("android-settings-after-dark.png")

        compose.onNodeWithTag("settings-row-KEYBOARD").performClick()
        compose.waitForIdle()
        assertEquals(listOf(Route.HOME, Route.SETTINGS, Route.KEYBOARD), navigator.stack)
        compose.onNodeWithContentDescription("Back").assertIsDisplayed()
        val rootWidth = compose.onRoot().getBoundsInRoot().width
        val restingLeft = compose.onNodeWithText("Push to talk").getBoundsInRoot().left

        compose.runOnUiThread {
            dispatcher.dispatchOnBackStarted(event(0f))
            dispatcher.dispatchOnBackProgressed(event(0.25f))
            dispatcher.dispatchOnBackProgressed(event(0.5f))
        }
        compose.waitForIdle()
        // Both pages are on screen: the one leaving, moved by exactly half the width, the one beneath showing through.
        val movedLeft = compose.onNodeWithText("Push to talk").getBoundsInRoot().left
        assertTrue("moved from $restingLeft to $movedLeft of $rootWidth", ((movedLeft - restingLeft) - rootWidth / 2).value in -2f..2f)
        compose.onNodeWithText("Speech model").assertExists()
        assertEquals(listOf(Route.HOME, Route.SETTINGS, Route.KEYBOARD), navigator.stack)
        save("android-back-after-dark.png")
        dark = false
        compose.waitForIdle()
        save("android-back-after-light.png")

        // Letting go finishes the pop onto Settings.
        compose.runOnUiThread { dispatcher.onBackPressed() }
        compose.waitForIdle()
        assertEquals(listOf(Route.HOME, Route.SETTINGS), navigator.stack)
        compose.onNodeWithText("Push to talk").assertDoesNotExist()
        compose.onNodeWithText("Speech model").assertIsDisplayed()
    }

    private fun save(name: String) {
        val dir = System.getProperty("murmur.screenshotDir")?.takeIf { it.isNotBlank() }?.let { File(it, "ia") } ?: return
        dir.mkdirs()
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width.coerceAtLeast(1), decor.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { decor.draw(Canvas(bitmap)) }
        FileOutputStream(File(dir, name)).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
