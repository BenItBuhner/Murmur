package app.murmur.android

import android.content.res.Configuration
import app.murmur.android.keyboard.DevicePosture
import app.murmur.android.keyboard.KeyboardDevice
import app.murmur.android.keyboard.KeyboardPresence
import app.murmur.android.keyboard.WidthClass
import app.murmur.android.keyboard.describeAutoOverlay
import app.murmur.android.keyboard.desktopOverlayOn
import app.murmur.android.overlay.PillPresentation
import app.murmur.android.settings.DesktopOverlay
import app.murmur.android.settings.KeyboardSettings
import app.murmur.android.settings.OverlayPosition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Whether a keyboard is attached and how wide the window is, from the configuration and the input
 * devices, and what the automatic overlay setting makes of it, including when the keyboard is
 * attached and detached while the app runs.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class KeyboardPresenceTest {

    private val bluetooth = KeyboardDevice("Logitech K380", alphabetic = true, virtual = false)
    private val virtual = KeyboardDevice("Virtual", alphabetic = true, virtual = true)
    private val remote = KeyboardDevice("TV remote", alphabetic = false, virtual = false)

    private fun config(width: Int = 411, keyboard: Int = Configuration.KEYBOARD_NOKEYS, hidden: Int = Configuration.HARDKEYBOARDHIDDEN_UNDEFINED) =
        Configuration().apply {
            screenWidthDp = width
            this.keyboard = keyboard
            hardKeyboardHidden = hidden
        }

    @Test
    fun `a phone with nothing attached is a phone`() {
        val p = KeyboardPresence.derive(config(), emptyList(), desktopSession = false)
        assertEquals(DevicePosture.PHONE, p)
        assertFalse(p.desktopLike)
    }

    @Test
    fun `the configuration alone is enough to count a keyboard`() {
        val p = KeyboardPresence.derive(config(keyboard = Configuration.KEYBOARD_QWERTY, hidden = Configuration.HARDKEYBOARDHIDDEN_NO), emptyList(), false)
        assertTrue(p.hardwareKeyboard)
        assertNull(p.keyboardName)
        assertTrue(p.desktopLike)
    }

    @Test
    fun `an alphabetic input device counts and is named while virtual devices and remotes do not`() {
        assertTrue(KeyboardPresence.derive(config(), listOf(remote, bluetooth), false).hardwareKeyboard)
        assertEquals("Logitech K380", KeyboardPresence.derive(config(), listOf(remote, bluetooth), false).keyboardName)
        assertFalse(KeyboardPresence.derive(config(), listOf(virtual), false).hardwareKeyboard)
        assertFalse(KeyboardPresence.derive(config(), listOf(remote), false).hardwareKeyboard)
    }

    @Test
    fun `a keyboard the configuration says is hidden does not count`() {
        val p = KeyboardPresence.derive(config(keyboard = Configuration.KEYBOARD_QWERTY, hidden = Configuration.HARDKEYBOARDHIDDEN_YES), listOf(bluetooth), false)
        assertFalse(p.hardwareKeyboard)
    }

    @Test
    fun `width classes follow Material's breakpoints`() {
        assertEquals(WidthClass.COMPACT, KeyboardPresence.derive(config(width = 599), emptyList(), false).widthClass)
        assertEquals(WidthClass.MEDIUM, KeyboardPresence.derive(config(width = 600), emptyList(), false).widthClass)
        assertEquals(WidthClass.MEDIUM, KeyboardPresence.derive(config(width = 839), emptyList(), false).widthClass)
        assertEquals(WidthClass.EXPANDED, KeyboardPresence.derive(config(width = 840), emptyList(), false).widthClass)
    }

    @Test
    fun `the automatic setting follows a keyboard, a desktop session or an expanded screen`() {
        val phone = DevicePosture.PHONE
        val tablet = DevicePosture(hardwareKeyboard = false, widthClass = WidthClass.EXPANDED, desktopSession = false)
        val medium = DevicePosture(hardwareKeyboard = false, widthClass = WidthClass.MEDIUM, desktopSession = false)
        val dex = DevicePosture(hardwareKeyboard = false, widthClass = WidthClass.COMPACT, desktopSession = true)
        val keyboard = DevicePosture(hardwareKeyboard = true, widthClass = WidthClass.COMPACT, desktopSession = false, keyboardName = "K380")
        assertFalse(desktopOverlayOn(DesktopOverlay.AUTO, phone))
        assertFalse("a small tablet without a keyboard keeps the button", desktopOverlayOn(DesktopOverlay.AUTO, medium))
        assertTrue(desktopOverlayOn(DesktopOverlay.AUTO, tablet))
        assertTrue(desktopOverlayOn(DesktopOverlay.AUTO, dex))
        assertTrue(desktopOverlayOn(DesktopOverlay.AUTO, keyboard))
        assertTrue(desktopOverlayOn(DesktopOverlay.ON, phone))
        assertFalse(desktopOverlayOn(DesktopOverlay.OFF, keyboard))
        assertTrue(describeAutoOverlay(keyboard).contains("K380"))
        assertTrue(describeAutoOverlay(phone).startsWith("Off right now"))
    }

    @Test
    fun `the presentation switches live as the keyboard is attached and detached`() {
        val app = RuntimeEnvironment.getApplication()
        val devices = ArrayList<KeyboardDevice>()
        val presence = KeyboardPresence(app, { devices.toList() }, { false })
        val settings = KeyboardSettings.DEFAULT
        assertFalse(presence.posture.value.hardwareKeyboard)
        assertEquals(PillPresentation.Button, PillPresentation.resolve(settings, presence.posture.value))

        // Attach: the input service lists the keyboard (and a configuration change may follow).
        devices += bluetooth
        presence.refresh()
        assertTrue(presence.posture.value.hardwareKeyboard)
        assertEquals("Logitech K380", presence.posture.value.keyboardName)
        val desktop = PillPresentation.resolve(settings, presence.posture.value)
        assertEquals(PillPresentation.Desktop(OverlayPosition.BOTTOM_CENTER, showIdle = true, touchControls = false), desktop)

        // Detach.
        devices.clear()
        presence.refresh()
        assertFalse(presence.posture.value.hardwareKeyboard)
        assertEquals(PillPresentation.Button, PillPresentation.resolve(settings, presence.posture.value))

        // The configuration of a wide, keyboard-less tablet: the desktop pill with touch controls.
        presence.refresh(config(width = 1280))
        assertEquals(WidthClass.EXPANDED, presence.posture.value.widthClass)
        assertEquals(
            PillPresentation.Desktop(OverlayPosition.BOTTOM_CENTER, showIdle = true, touchControls = true),
            PillPresentation.resolve(settings, presence.posture.value)
        )
        // Forced off, the button stays whatever is attached.
        assertEquals(PillPresentation.Button, PillPresentation.resolve(settings.copy(desktopOverlay = DesktopOverlay.OFF), presence.posture.value))
    }
}
