package app.murmur.android

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import app.murmur.android.keyboard.Key
import app.murmur.android.keyboard.KeyboardPresence
import app.murmur.android.keyboard.ShortcutCapture
import app.murmur.android.keyboard.ShortcutRecorder
import app.murmur.android.settings.DesktopOverlay
import app.murmur.android.settings.KeyboardSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.KeyboardScreen
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.theme.MurmurTheme
import org.junit.After
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
import java.io.File
import java.io.FileOutputStream

/**
 * The Keyboard screen: the defaults on their key caps, the recorder taking a chord from the
 * service's capture stream (and refusing a reserved one), and the settings behind the switches.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class KeyboardScreenTest {

    @get:Rule
    val compose = createComposeRule()

    private lateinit var store: SettingsStore
    private lateinit var root: View
    private var serviceRunning = true

    @Before
    fun setUp() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        store = SettingsStore(context)
        KeyboardPresence.get(context).refresh(Configuration())
        ShortcutRecorder.serviceRunning = { serviceRunning }
        compose.setContent {
            root = LocalView.current
            val settings by store.flow.collectAsState()
            MurmurTheme(settings.copy(dynamicColor = false)) {
                KeyboardScreen(store, settings, TopNav.Back {})
            }
        }
        compose.waitForIdle()
    }

    @After
    fun tearDown() {
        ShortcutRecorder.stop()
        ShortcutRecorder.serviceRunning = { app.murmur.android.service.MurmurAccessibilityService.isRunning }
        // KeyboardPresence is one per process and outlives this test: leave it a keyboard-less phone.
        KeyboardPresence.get(RuntimeEnvironment.getApplication()).refresh(Configuration())
    }

    private fun keyboard(): KeyboardSettings = store.get().keyboard

    @Test
    fun `the defaults are shown as key caps and the device's state is described`() {
        compose.onNodeWithText("No physical keyboard").assertIsDisplayed()
        compose.onNodeWithContentDescription("Push to talk: Ctrl + Meta").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Hands-free shortcut: Ctrl + Meta + Space").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Edit selection: Shift + Meta").performScrollTo().assertIsDisplayed()
        // Key caps carry the key names one by one.
        assertTrue(compose.onAllNodesWithText("Ctrl").fetchSemanticsNodes().size >= 2)
        compose.onAllNodesWithText("Meta").fetchSemanticsNodes().let { assertTrue(it.size >= 3) }
    }

    @Test
    fun `Change records the chord the service streams and stores it`() {
        compose.onNodeWithContentDescription("Push to talk: Ctrl + Meta").performScrollTo()
        compose.onAllNodesWithText("Change")[0].performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Press your shortcut…").assertIsDisplayed()
        compose.onNodeWithText("Cancel").assertIsDisplayed()

        // The service sees Ctrl, then F9, live.
        ShortcutRecorder.publish(ShortcutCapture(listOf(Key.CTRL), "Ctrl", valid = true))
        compose.waitForIdle()
        ShortcutRecorder.publish(ShortcutCapture(listOf(Key.CTRL, Key.F9), "Ctrl + F9", valid = true))
        compose.waitForIdle()
        compose.onNodeWithText("F9").assertIsDisplayed()

        // All keys released: the chord is stored and shown.
        ShortcutRecorder.publish(ShortcutCapture(listOf(Key.CTRL, Key.F9), "Ctrl + F9", valid = true, final = true))
        compose.waitForIdle()
        assertEquals(listOf(Key.CTRL, Key.F9), keyboard().pushToTalk)
        compose.onNodeWithContentDescription("Push to talk: Ctrl + F9").assertIsDisplayed()
        compose.onNodeWithText("Cancel").assertDoesNotExist()
    }

    @Test
    fun `a reserved chord is refused with the reason and the old one is kept`() {
        compose.onNodeWithContentDescription("Edit selection: Shift + Meta").performScrollTo()
        compose.onAllNodesWithText("Change")[2].performClick()
        compose.waitForIdle()
        ShortcutRecorder.publish(
            ShortcutCapture(listOf(Key.ALT, Key.META), "Alt + Meta", valid = false, reason = "Alt + Meta is reserved by Android: it toggles Caps Lock.", final = true)
        )
        compose.waitForIdle()
        compose.onNodeWithText("Alt + Meta is reserved by Android: it toggles Caps Lock.").assertIsDisplayed()
        assertEquals(KeyboardSettings.DEFAULT_COMMAND_MODE, keyboard().commandMode)
    }

    @Test
    fun `without the accessibility service the recorder says what to turn on`() {
        serviceRunning = false
        compose.onNodeWithContentDescription("Push to talk: Ctrl + Meta").performScrollTo()
        compose.onAllNodesWithText("Change")[0].performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Turn on the accessibility service under Permissions first; it is what sees the keys.").assertIsDisplayed()
        compose.onNodeWithText("Press your shortcut…").assertDoesNotExist()
    }

    @Test
    fun `the optional shortcuts can be removed and the switches write the section`() {
        compose.onNodeWithContentDescription("Remove Hands-free shortcut").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(emptyList<Int>(), keyboard().handsFree)
        compose.onNodeWithContentDescription("Hands-free shortcut: Not set").assertIsDisplayed()

        compose.onNodeWithText("Esc cancels").performScrollTo().assertIsOn().performClick()
        compose.waitForIdle()
        assertFalse(keyboard().escapeCancels)
        compose.onNodeWithText("Esc cancels").assertIsOff()

        compose.onNodeWithText("OVERLAY").performScrollTo()
        compose.onNodeWithText("Overlay position").performScrollTo()
        // The second "Off" on the screen: the hands-free trigger has the first.
        compose.onAllNodesWithText("Off")[1].performClick()
        compose.waitForIdle()
        assertEquals(DesktopOverlay.OFF, keyboard().desktopOverlay)
        compose.onNodeWithText("The floating button beside the keyboard, whatever is attached.").assertIsDisplayed()
    }

    @Test
    fun `Tap the idle bar to dictate is off by default, waits for keyboard mode and writes the setting`() {
        // A phone with nothing attached: keyboard mode is off, so the switch is shown but greyed out.
        compose.onNodeWithText("Tap the idle bar to dictate").performScrollTo().assertIsOff().assertIsNotEnabled()
        assertFalse(keyboard().tapIdleBarToDictate)

        // A keyboard is attached: keyboard mode turns on by itself and the switch can be used.
        KeyboardPresence.get(RuntimeEnvironment.getApplication()).refresh(
            Configuration().apply {
                keyboard = Configuration.KEYBOARD_QWERTY
                hardKeyboardHidden = Configuration.HARDKEYBOARDHIDDEN_NO
            }
        )
        compose.waitForIdle()
        compose.onNodeWithText("A keyboard is connected").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Tap the idle bar to dictate").performScrollTo().assertIsEnabled().assertIsOff()
        snap("android-keyboard-mode-tap-idle-bar-setting")

        compose.onNodeWithText("Tap the idle bar to dictate").performClick()
        compose.waitForIdle()
        assertTrue(keyboard().tapIdleBarToDictate)
        compose.onNodeWithText("Tap the idle bar to dictate").assertIsOn()

        // Without the idle indicator there is no bar to tap.
        compose.onNodeWithText("Show idle indicator").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Tap the idle bar to dictate").assertIsNotEnabled()
    }

    /** The screen as rendered, written under build/reports/pill-screenshots/keyboard-mode. */
    private fun snap(name: String) {
        val dir = System.getProperty("murmur.screenshotDir")?.takeIf { it.isNotBlank() }?.let { File(it, "keyboard-mode") } ?: return
        dir.mkdirs()
        compose.waitForIdle()
        val view = root.rootView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { view.draw(Canvas(bitmap)) }
        FileOutputStream(File(dir, "$name.png")).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
