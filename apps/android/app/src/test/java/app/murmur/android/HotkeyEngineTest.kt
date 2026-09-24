package app.murmur.android

import app.murmur.android.dictation.DictationMode
import app.murmur.android.keyboard.HotkeyAction
import app.murmur.android.keyboard.HotkeyEngine
import app.murmur.android.keyboard.HotkeyEngineConfig
import app.murmur.android.keyboard.Key
import app.murmur.android.keyboard.Keys
import app.murmur.android.settings.HandsFreeTrigger
import app.murmur.android.settings.KeyboardSettings
import app.murmur.android.settings.KeyboardSettingsCodec
import app.murmur.android.settings.DesktopOverlay
import app.murmur.android.settings.OverlayPosition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The shortcut state machine, case for case the desktop's hotkey-engine.test.ts: the same key codes
 * in, the same actions out, so a shortcut behaves on a tablet exactly as it does on the desktop.
 */
class HotkeyEngineTest {
    private val base = HotkeyEngineConfig(
        pushToTalk = listOf(Key.CTRL, Key.META),
        handsFree = listOf(Key.CTRL, Key.META, Key.SPACE),
        commandMode = listOf(Key.SHIFT, Key.META),
        handsFreeTrigger = HandsFreeTrigger.TAP,
        tapThresholdMs = 350,
        doubleTapWindowMs = 400,
        sideSensitive = false,
        escapeCancels = true
    )

    private fun make(change: (HotkeyEngineConfig) -> HotkeyEngineConfig = { it }) = HotkeyEngine(change(base))

    private val start = HotkeyAction.Start(DictationMode.HOLD)
    private val none = emptyList<HotkeyAction>()

    @Test
    fun `push to talk starts on chord press and stops on release after the tap threshold`() {
        val e = make()
        assertEquals(none, e.keyDown(Key.CTRL, 0))
        assertEquals(listOf(start), e.keyDown(Key.META, 10))
        assertTrue(e.isListening)
        assertEquals(listOf(HotkeyAction.Stop), e.keyUp(Key.META, 1200))
        assertEquals(none, e.keyUp(Key.CTRL, 1210))
        assertFalse(e.isListening)
    }

    @Test
    fun `key repeat presses are ignored`() {
        val e = make()
        e.keyDown(Key.CTRL, 0)
        assertEquals(1, e.keyDown(Key.META, 10).size)
        assertEquals(none, e.keyDown(Key.META, 40))
        assertEquals(none, e.keyDown(Key.CTRL, 41))
        assertEquals(none, e.keyDown(Key.META, 80))
    }

    @Test
    fun `right-hand modifiers match when not side sensitive, and not when they are`() {
        val e = make()
        e.keyDown(Key.CTRL_RIGHT, 0)
        assertEquals(listOf(start), e.keyDown(Key.META_RIGHT, 5))
        assertEquals(listOf(HotkeyAction.Stop), e.keyUp(Key.CTRL_RIGHT, 900))

        val sided = make { it.copy(sideSensitive = true, pushToTalk = listOf(Key.CTRL_RIGHT)) }
        assertEquals(none, sided.keyDown(Key.CTRL, 0))
        assertEquals(listOf(start), sided.keyDown(Key.CTRL_RIGHT, 1))
    }

    @Test
    fun `releasing a key that is not part of the chord does nothing`() {
        val e = make()
        e.keyDown(Key.CTRL, 0)
        e.keyDown(Key.META, 1)
        e.keyDown(Key.A, 500)
        assertEquals(none, e.keyUp(Key.A, 600))
        assertTrue(e.isListening)
    }

    @Test
    fun `a quick tap locks the session and the next press stops it`() {
        val e = make()
        e.keyDown(Key.CTRL, 0)
        assertEquals(listOf(start), e.keyDown(Key.META, 1))
        assertEquals(listOf(HotkeyAction.Lock), e.keyUp(Key.META, 200))
        assertEquals(none, e.keyUp(Key.CTRL, 210))
        assertTrue(e.isLocked)
        e.keyDown(Key.CTRL, 9000)
        assertEquals(listOf(HotkeyAction.Stop), e.keyDown(Key.META, 9001))
        assertEquals(none, e.keyUp(Key.META, 9100))
        assertEquals(none, e.keyUp(Key.CTRL, 9101))
        assertFalse(e.isListening)
        // A press right after a stop starts a fresh hold session.
        e.keyDown(Key.CTRL, 10000)
        assertEquals(listOf(start), e.keyDown(Key.META, 10001))
    }

    @Test
    fun `with the double-tap trigger a single tap stops and a second tap inside the window starts locked`() {
        val e = make { it.copy(handsFreeTrigger = HandsFreeTrigger.DOUBLE_TAP) }
        e.keyDown(Key.CTRL, 0)
        e.keyDown(Key.META, 1)
        assertEquals(listOf(HotkeyAction.Stop), e.keyUp(Key.META, 150))
        e.keyUp(Key.CTRL, 160)
        e.keyDown(Key.CTRL, 300)
        assertEquals(listOf(HotkeyAction.Start(DictationMode.HANDS_FREE)), e.keyDown(Key.META, 301))
        assertEquals(none, e.keyUp(Key.META, 400))
        assertTrue(e.isLocked)

        val late = make { it.copy(handsFreeTrigger = HandsFreeTrigger.DOUBLE_TAP) }
        late.keyDown(Key.CTRL, 0)
        late.keyDown(Key.META, 1)
        late.keyUp(Key.META, 150)
        late.keyUp(Key.CTRL, 160)
        late.keyDown(Key.CTRL, 2000)
        assertEquals(listOf(start), late.keyDown(Key.META, 2001))
    }

    @Test
    fun `with the trigger off a quick tap just stops`() {
        val e = make { it.copy(handsFreeTrigger = HandsFreeTrigger.OFF) }
        e.keyDown(Key.CTRL, 0)
        e.keyDown(Key.META, 1)
        assertEquals(listOf(HotkeyAction.Stop), e.keyUp(Key.CTRL, 100))
    }

    @Test
    fun `the dedicated hands-free chord locks a hold and toggles from idle`() {
        val e = make()
        e.keyDown(Key.CTRL, 0)
        e.keyDown(Key.META, 1)
        assertEquals(listOf(HotkeyAction.Lock), e.keyDown(Key.SPACE, 2))
        assertEquals(none, e.keyUp(Key.SPACE, 100))
        assertEquals(none, e.keyUp(Key.META, 101))
        assertEquals(none, e.keyUp(Key.CTRL, 102))
        assertTrue(e.isLocked)
        e.keyDown(Key.CTRL, 5000)
        assertEquals(listOf(HotkeyAction.Stop), e.keyDown(Key.META, 5001))
        assertFalse(e.isListening)

        val direct = make { it.copy(pushToTalk = listOf(Key.F9), handsFree = listOf(Key.CTRL, Key.F9)) }
        direct.keyDown(Key.CTRL, 0)
        assertEquals(listOf(HotkeyAction.Start(DictationMode.HANDS_FREE)), direct.keyDown(Key.F9, 1))
        assertTrue(direct.isLocked)
        assertEquals(none, direct.keyUp(Key.F9, 50))
    }

    @Test
    fun `the command chord starts a command session that stops on release even when short`() {
        val e = make()
        e.keyDown(Key.SHIFT, 0)
        assertEquals(listOf(HotkeyAction.Start(DictationMode.COMMAND)), e.keyDown(Key.META, 1))
        assertEquals(DictationMode.COMMAND, e.currentMode)
        assertEquals(listOf(HotkeyAction.Stop), e.keyUp(Key.SHIFT, 100))
    }

    @Test
    fun `escape cancels a listening session and does nothing when idle`() {
        val e = make()
        assertEquals(none, e.keyDown(Key.ESCAPE, 0))
        e.keyUp(Key.ESCAPE, 1)
        e.keyDown(Key.CTRL, 10)
        e.keyDown(Key.META, 11)
        assertEquals(listOf(HotkeyAction.Cancel), e.keyDown(Key.ESCAPE, 500))
        assertFalse(e.isListening)
        assertEquals(none, e.keyUp(Key.META, 600))
    }

    @Test
    fun `a session started from the button is stopped by the chord`() {
        val e = make()
        e.externalStart(DictationMode.HANDS_FREE, 0)
        assertTrue(e.isLocked)
        e.keyDown(Key.CTRL, 100)
        assertEquals(listOf(HotkeyAction.Stop), e.keyDown(Key.META, 101))
        e.externalStop()
        assertFalse(e.isListening)
    }

    @Test
    fun `the last matched chord is reported for the filter`() {
        val e = make()
        e.keyDown(Key.CTRL, 0)
        e.keyDown(Key.META, 1)
        assertEquals(listOf(Key.CTRL, Key.META), e.lastMatchedChord)
        e.keyDown(Key.A, 2)
        assertEquals(emptyList<Int>(), e.lastMatchedChord)
    }

    // ---- key identity and rules -----------------------------------------------------------------

    @Test
    fun `validation mirrors the desktop rules and adds Android's own combinations`() {
        assertFalse(Keys.validateChord(listOf(Key.A)).valid)
        assertTrue(Keys.validateChord(listOf(Key.F9)).valid)
        assertTrue(Keys.validateChord(listOf(Key.CTRL, Key.META)).valid)
        assertTrue(Keys.validateChord(listOf(Key.CTRL_RIGHT)).valid)
        assertFalse(Keys.validateChord(listOf(Key.CTRL, Key.ALT, Key.SHIFT, Key.META)).valid)
        assertFalse(Keys.validateChord(listOf(Key.CTRL, Key.C)).valid)
        assertFalse(Keys.validateChord(listOf(Key.CTRL, Key.CTRL_RIGHT)).valid)
        assertFalse(Keys.validateChord(listOf(Key.ESCAPE)).valid)
        // The desktop's command default toggles Caps Lock on Android, so it is refused here.
        val altMeta = Keys.validateChord(listOf(Key.ALT, Key.META))
        assertFalse(altMeta.valid)
        assertTrue(altMeta.reason!!, altMeta.reason!!.contains("Caps Lock"))
        assertFalse(Keys.validateChord(listOf(Key.META, Key.L)).valid)
        assertTrue(Keys.validateChord(KeyboardSettings.DEFAULT_PUSH_TO_TALK).valid)
        assertTrue(Keys.validateChord(KeyboardSettings.DEFAULT_HANDS_FREE).valid)
        assertTrue(Keys.validateChord(KeyboardSettings.DEFAULT_COMMAND_MODE).valid)
    }

    @Test
    fun `labels name the keys as Android does and keep the desktop order`() {
        assertEquals("Ctrl + Meta", Keys.chordLabel(listOf(Key.META, Key.CTRL)))
        assertEquals("Ctrl + Meta + Space", Keys.chordLabel(listOf(Key.SPACE, Key.META, Key.CTRL)))
        assertEquals("Shift + Meta", Keys.chordLabel(listOf(Key.META, Key.SHIFT)))
        assertEquals("Right Ctrl", Keys.chordLabel(listOf(Key.CTRL_RIGHT), sideSensitive = true))
        assertEquals("Ctrl", Keys.chordLabel(listOf(Key.CTRL_RIGHT)))
        assertEquals("F9", Keys.chordLabel(listOf(Key.F9)))
        assertEquals("Not set", Keys.chordLabel(emptyList()))
    }

    @Test
    fun `Android keycodes map onto the desktop codes the settings store`() {
        assertEquals(Key.CTRL, Keys.fromAndroid(android.view.KeyEvent.KEYCODE_CTRL_LEFT))
        assertEquals(Key.META, Keys.fromAndroid(android.view.KeyEvent.KEYCODE_META_LEFT))
        assertEquals(Key.META_RIGHT, Keys.fromAndroid(android.view.KeyEvent.KEYCODE_META_RIGHT))
        assertEquals(Key.SPACE, Keys.fromAndroid(android.view.KeyEvent.KEYCODE_SPACE))
        assertEquals(Key.A, Keys.fromAndroid(android.view.KeyEvent.KEYCODE_A))
        assertEquals(Key.F12, Keys.fromAndroid(android.view.KeyEvent.KEYCODE_F12))
        assertEquals(Key.ESCAPE, Keys.fromAndroid(android.view.KeyEvent.KEYCODE_ESCAPE))
        val volumeUp = Keys.fromAndroid(android.view.KeyEvent.KEYCODE_VOLUME_UP)
        assertTrue(Keys.isAndroidOnly(volumeUp))
    }

    // ---- the stored section -----------------------------------------------------------------------

    @Test
    fun `keyboard settings round-trip and survive garbage`() {
        val s = KeyboardSettings(
            shortcuts = false,
            pushToTalk = listOf(Key.F9),
            handsFree = emptyList(),
            commandMode = listOf(Key.CTRL, Key.ALT, Key.META),
            handsFreeTrigger = HandsFreeTrigger.DOUBLE_TAP,
            tapThresholdMs = 200,
            doubleTapWindowMs = 500,
            sideSensitive = true,
            escapeCancels = false,
            desktopOverlay = DesktopOverlay.ON,
            overlayPosition = OverlayPosition.TOP_CENTER,
            showOverlayWhenIdle = false
        )
        assertEquals(s, KeyboardSettingsCodec.decode(KeyboardSettingsCodec.encode(s)))
        assertEquals(KeyboardSettings.DEFAULT, KeyboardSettingsCodec.decode(null))
        assertEquals(KeyboardSettings.DEFAULT, KeyboardSettingsCodec.decode("not json"))
        // Unknown fields (a newer build) are ignored; the known ones are read; out-of-range numbers are clamped.
        val partial = KeyboardSettingsCodec.decode("""{"pushToTalk":[67],"tapThresholdMs":5,"future":true,"overlayPosition":"bottom-right"}""")
        assertEquals(listOf(Key.F9), partial.pushToTalk)
        assertEquals(80, partial.tapThresholdMs)
        assertEquals(OverlayPosition.BOTTOM_RIGHT, partial.overlayPosition)
        assertEquals(KeyboardSettings.DEFAULT_HANDS_FREE, partial.handsFree)
    }

    @Test
    fun `the defaults are the desktop's where Android allows them`() {
        val d = KeyboardSettings.DEFAULT
        // Ctrl + Meta and Ctrl + Meta + Space: the desktop's [29, 3675] and [29, 3675, 57].
        assertEquals(listOf(29, 3675), d.pushToTalk)
        assertEquals(listOf(29, 3675, 57), d.handsFree)
        // Not the desktop's Alt + Meta ([56, 3675]): Android toggles Caps Lock on it.
        assertEquals(listOf(42, 3675), d.commandMode)
        assertNull(Keys.validateChord(d.commandMode).reason)
    }
}
