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
 * Whether a keyboard is attached and whether the screen is a tablet's, from the configuration and
 * the input devices, and what the automatic overlay setting makes of it, including when the
 * keyboard is attached and detached, and the device turned, while the app runs.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class KeyboardPresenceTest {

    private val bluetooth = KeyboardDevice("Logitech K380", alphabetic = true, virtual = false)
    private val virtual = KeyboardDevice("Virtual", alphabetic = true, virtual = true)
    private val remote = KeyboardDevice("TV remote", alphabetic = false, virtual = false)

    private fun config(
        width: Int = 411,
        height: Int = 891,
        keyboard: Int = Configuration.KEYBOARD_NOKEYS,
        hidden: Int = Configuration.HARDKEYBOARDHIDDEN_UNDEFINED
    ) = Configuration().apply {
        screenWidthDp = width
        screenHeightDp = height
        smallestScreenWidthDp = minOf(width, height)
        orientation = if (width > height) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
        this.keyboard = keyboard
        hardKeyboardHidden = hidden
    }

    /** A Galaxy S26 Ultra at the display size in Bennett's recording (about 2.58 px per dp on 1080 x 2340). */
    private val phonePortrait = config(width = 418, height = 907)
    private val phoneLandscape = config(width = 907, height = 418)

    /** A 10-inch tablet: 1280 x 800 dp. */
    private val tabletPortrait = config(width = 800, height = 1280)
    private val tabletLandscape = config(width = 1280, height = 800)

    private fun withKeyboard(c: Configuration) = Configuration(c).apply {
        keyboard = Configuration.KEYBOARD_QWERTY
        hardKeyboardHidden = Configuration.HARDKEYBOARDHIDDEN_NO
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
    fun `a phone on its side is still a phone and keeps the floating button`() {
        // On its side the S26 Ultra is 907 dp wide: past the 840 dp that used to turn the pill on.
        for (c in listOf(phonePortrait, phoneLandscape)) {
            val p = KeyboardPresence.derive(c, emptyList(), false)
            assertFalse("${c.screenWidthDp} x ${c.screenHeightDp} dp", p.tabletScreen)
            assertFalse(p.desktopLike)
            assertEquals(PillPresentation.Button, PillPresentation.resolve(KeyboardSettings.DEFAULT, p))
        }
        assertTrue(describeAutoOverlay(KeyboardPresence.derive(phoneLandscape, emptyList(), false)).startsWith("Off right now"))
    }

    @Test
    fun `a tablet is a tablet either way up, from the smallest one up`() {
        for (c in listOf(tabletPortrait, tabletLandscape, config(width = 600, height = 960), config(width = 960, height = 600))) {
            val p = KeyboardPresence.derive(c, emptyList(), false)
            assertTrue("${c.screenWidthDp} x ${c.screenHeightDp} dp", p.tabletScreen)
            assertEquals(
                PillPresentation.Desktop(OverlayPosition.BOTTOM_CENTER, showIdle = true, touchControls = true, idleTap = true),
                PillPresentation.resolve(KeyboardSettings.DEFAULT, p)
            )
        }
        assertFalse("a shorter side of 599 dp is a phone's", KeyboardPresence.derive(config(width = 599, height = 900), emptyList(), false).tabletScreen)
        assertEquals("On right now: this is a tablet-sized screen.", describeAutoOverlay(KeyboardPresence.derive(tabletPortrait, emptyList(), false)))
    }

    @Test
    fun `width classes for the app's own layout follow Material's breakpoints`() {
        assertEquals(WidthClass.COMPACT, WidthClass.of(599))
        assertEquals(WidthClass.MEDIUM, WidthClass.of(600))
        assertEquals(WidthClass.MEDIUM, WidthClass.of(839))
        assertEquals(WidthClass.EXPANDED, WidthClass.of(840))
    }

    @Test
    fun `the automatic setting follows a keyboard, a desktop session or a tablet-sized screen`() {
        val phone = DevicePosture.PHONE
        val tablet = DevicePosture(hardwareKeyboard = false, tabletScreen = true, desktopSession = false)
        val dex = DevicePosture(hardwareKeyboard = false, tabletScreen = false, desktopSession = true)
        val keyboard = DevicePosture(hardwareKeyboard = true, tabletScreen = false, desktopSession = false, keyboardName = "K380")
        assertFalse(desktopOverlayOn(DesktopOverlay.AUTO, phone))
        assertTrue(desktopOverlayOn(DesktopOverlay.AUTO, tablet))
        assertTrue(desktopOverlayOn(DesktopOverlay.AUTO, dex))
        assertTrue(desktopOverlayOn(DesktopOverlay.AUTO, keyboard))
        assertTrue(desktopOverlayOn(DesktopOverlay.ON, phone))
        assertFalse(desktopOverlayOn(DesktopOverlay.OFF, keyboard))
        assertTrue(describeAutoOverlay(keyboard).contains("K380"))
        assertTrue(describeAutoOverlay(phone).startsWith("Off right now"))
    }

    @Test
    fun `the idle bar takes a tap only when asked to, or when there is no keyboard to start from`() {
        val keyboard = DevicePosture(hardwareKeyboard = true, tabletScreen = false, desktopSession = false)
        val dexWithoutKeyboard = DevicePosture(hardwareKeyboard = false, tabletScreen = false, desktopSession = true)
        val tapOn = KeyboardSettings.DEFAULT.copy(tapIdleBarToDictate = true)
        assertFalse((PillPresentation.resolve(KeyboardSettings.DEFAULT, keyboard) as PillPresentation.Desktop).idleTap)
        assertTrue((PillPresentation.resolve(tapOn, keyboard) as PillPresentation.Desktop).idleTap)
        assertTrue((PillPresentation.resolve(KeyboardSettings.DEFAULT, dexWithoutKeyboard) as PillPresentation.Desktop).idleTap)
        assertTrue((PillPresentation.resolve(KeyboardSettings.DEFAULT.copy(desktopOverlay = DesktopOverlay.ON), DevicePosture.PHONE) as PillPresentation.Desktop).idleTap)
    }

    @Test
    fun `the presentation switches live as the keyboard is attached and detached, and holds when the device turns`() {
        val app = RuntimeEnvironment.getApplication()
        val devices = ArrayList<KeyboardDevice>()
        val presence = KeyboardPresence(app, { devices.toList() }, { false })
        val settings = KeyboardSettings.DEFAULT
        fun presentation() = PillPresentation.resolve(settings, presence.posture.value)
        val keyboardPill = PillPresentation.Desktop(OverlayPosition.BOTTOM_CENTER, showIdle = true, touchControls = false, idleTap = false)
        val tabletPill = PillPresentation.Desktop(OverlayPosition.BOTTOM_CENTER, showIdle = true, touchControls = true, idleTap = true)

        // A phone, turned both ways: the floating button.
        presence.refresh(phonePortrait)
        assertEquals(PillPresentation.Button, presentation())
        presence.refresh(phoneLandscape)
        assertEquals(PillPresentation.Button, presentation())
        presence.refresh(phonePortrait)
        assertEquals(PillPresentation.Button, presentation())

        // Attach: the input service lists the keyboard (and a configuration change may follow).
        devices += bluetooth
        presence.refresh(phonePortrait)
        assertTrue(presence.posture.value.hardwareKeyboard)
        assertEquals("Logitech K380", presence.posture.value.keyboardName)
        assertEquals(keyboardPill, presentation())
        // Turned with the keyboard attached: still the keyboard's pill.
        presence.refresh(withKeyboard(phoneLandscape))
        assertEquals(keyboardPill, presentation())

        // Detach, on its side: back to the button, not the tablet's pill.
        devices.clear()
        presence.refresh(phoneLandscape)
        assertFalse(presence.posture.value.hardwareKeyboard)
        assertEquals(PillPresentation.Button, presentation())

        // A keyboard-less tablet, both ways up: the desktop pill with touch controls and a tappable bar.
        presence.refresh(tabletPortrait)
        assertEquals(tabletPill, presentation())
        presence.refresh(tabletLandscape)
        assertEquals(tabletPill, presentation())
        // A keyboard on the tablet takes the touch controls and the bar's tap away; its removal gives them back.
        presence.refresh(withKeyboard(tabletLandscape))
        assertEquals(keyboardPill, presentation())
        presence.refresh(tabletPortrait)
        assertEquals(tabletPill, presentation())
        // Forced off, the button stays whatever is attached.
        assertEquals(PillPresentation.Button, PillPresentation.resolve(settings.copy(desktopOverlay = DesktopOverlay.OFF), presence.posture.value))
    }
}
