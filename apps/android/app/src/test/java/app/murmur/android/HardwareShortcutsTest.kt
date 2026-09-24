package app.murmur.android

import android.view.KeyEvent
import app.murmur.android.dictation.DictationMode
import app.murmur.android.keyboard.HardwareShortcuts
import app.murmur.android.keyboard.HotkeyAction
import app.murmur.android.keyboard.Key
import app.murmur.android.keyboard.ShortcutCapture
import app.murmur.android.settings.KeyboardSettings
import app.murmur.android.keyboard.toEngineConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The key-event filter: which hardware keys the service takes and which reach the app underneath.
 * A key of a shortcut is taken from the moment the chord completes; everything else, including a
 * chord that never completes, passes through, so typing is never affected.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class HardwareShortcutsTest {

    private val actions = ArrayList<HotkeyAction>()
    private val filter = HardwareShortcuts(KeyboardSettings.DEFAULT.toEngineConfig()) { actions += it }
    private var now = 0L

    private fun key(action: Int, keyCode: Int, repeat: Int = 0): KeyEvent =
        KeyEvent(now, now, action, keyCode, repeat)

    /** @return true when the filter took the event. */
    private fun down(keyCode: Int, at: Long = now): Boolean {
        now = at
        return filter.onKeyEvent(key(KeyEvent.ACTION_DOWN, keyCode), now)
    }

    private fun up(keyCode: Int, at: Long = now): Boolean {
        now = at
        return filter.onKeyEvent(key(KeyEvent.ACTION_UP, keyCode), now)
    }

    private fun repeat(keyCode: Int, at: Long = now): Boolean {
        now = at
        return filter.onKeyEvent(key(KeyEvent.ACTION_DOWN, keyCode, repeat = 1), now)
    }

    private fun taken(): List<HotkeyAction> = actions.toList().also { actions.clear() }

    @Test
    fun `holding Ctrl + Meta records, the key that completes the chord is taken and the first one passes`() {
        assertFalse("Ctrl alone may be the start of Ctrl+C", down(KeyEvent.KEYCODE_CTRL_LEFT, 0))
        assertTrue(down(KeyEvent.KEYCODE_META_LEFT, 10))
        assertEquals(listOf(HotkeyAction.Start(DictationMode.HOLD)), taken())
        assertTrue(filter.isListening)

        assertTrue("the release of a taken key is taken", up(KeyEvent.KEYCODE_META_LEFT, 1200))
        assertEquals(listOf(HotkeyAction.Stop), taken())
        assertFalse("Ctrl was passed through, so its release is too", up(KeyEvent.KEYCODE_CTRL_LEFT, 1210))
        assertFalse(filter.isListening)
    }

    @Test
    fun `Meta pressed first is swallowed on release so Android never sees a Meta tap`() {
        assertFalse(down(KeyEvent.KEYCODE_META_LEFT, 0))
        assertTrue(down(KeyEvent.KEYCODE_CTRL_LEFT, 10))
        assertEquals(listOf(HotkeyAction.Start(DictationMode.HOLD)), taken())
        assertTrue(up(KeyEvent.KEYCODE_CTRL_LEFT, 900))
        assertEquals(listOf(HotkeyAction.Stop), taken())
        assertTrue("Meta took part in the shortcut: its release must not read as a tap", up(KeyEvent.KEYCODE_META_LEFT, 910))
    }

    @Test
    fun `a tap locks hands-free and the next chord press stops it`() {
        down(KeyEvent.KEYCODE_CTRL_LEFT, 0)
        down(KeyEvent.KEYCODE_META_LEFT, 1)
        assertEquals(listOf(HotkeyAction.Start(DictationMode.HOLD)), taken())
        assertTrue(up(KeyEvent.KEYCODE_META_LEFT, 200))
        assertEquals(listOf(HotkeyAction.Lock), taken())
        assertFalse(up(KeyEvent.KEYCODE_CTRL_LEFT, 210))
        assertTrue(filter.isListening)

        // Typing while dictating hands-free reaches the app untouched.
        assertFalse(down(KeyEvent.KEYCODE_H, 3000))
        assertFalse(up(KeyEvent.KEYCODE_H, 3050))
        assertEquals(emptyList<HotkeyAction>(), taken())

        down(KeyEvent.KEYCODE_CTRL_LEFT, 9000)
        assertTrue(down(KeyEvent.KEYCODE_META_LEFT, 9001))
        assertEquals(listOf(HotkeyAction.Stop), taken())
        assertTrue(up(KeyEvent.KEYCODE_META_LEFT, 9100))
        assertFalse(up(KeyEvent.KEYCODE_CTRL_LEFT, 9101))
    }

    @Test
    fun `keys that are not part of a shortcut pass through, alone and with modifiers`() {
        assertFalse(down(KeyEvent.KEYCODE_A, 0))
        assertFalse(up(KeyEvent.KEYCODE_A, 50))
        // Ctrl + C is copy: neither key is touched.
        assertFalse(down(KeyEvent.KEYCODE_CTRL_LEFT, 100))
        assertFalse(down(KeyEvent.KEYCODE_C, 110))
        assertFalse(up(KeyEvent.KEYCODE_C, 150))
        assertFalse(up(KeyEvent.KEYCODE_CTRL_LEFT, 160))
        // Meta + Tab (recents) is not ours either.
        assertFalse(down(KeyEvent.KEYCODE_META_LEFT, 200))
        assertFalse(down(KeyEvent.KEYCODE_TAB, 210))
        assertFalse(up(KeyEvent.KEYCODE_TAB, 250))
        assertFalse(up(KeyEvent.KEYCODE_META_LEFT, 260))
        assertEquals(emptyList<HotkeyAction>(), taken())
        assertFalse(filter.isListening)
    }

    @Test
    fun `a letter pressed during a hold passes through but the chord's own repeats do not`() {
        down(KeyEvent.KEYCODE_CTRL_LEFT, 0)
        down(KeyEvent.KEYCODE_META_LEFT, 1)
        taken()
        assertTrue("the app never saw Meta go down, so it must not see it repeat", repeat(KeyEvent.KEYCODE_META_LEFT, 500))
        assertFalse("Ctrl was passed, so its repeats are too", repeat(KeyEvent.KEYCODE_CTRL_LEFT, 510))
        assertFalse(down(KeyEvent.KEYCODE_A, 600))
        assertFalse(up(KeyEvent.KEYCODE_A, 650))
        assertTrue(filter.isListening)
        assertEquals(emptyList<HotkeyAction>(), taken())
    }

    @Test
    fun `the hands-free chord takes Space before Android can switch the input method on it`() {
        down(KeyEvent.KEYCODE_CTRL_LEFT, 0)
        down(KeyEvent.KEYCODE_META_LEFT, 1)
        taken()
        assertTrue(down(KeyEvent.KEYCODE_SPACE, 2))
        assertEquals(listOf(HotkeyAction.Lock), taken())
        assertTrue(up(KeyEvent.KEYCODE_SPACE, 100))
        assertTrue(up(KeyEvent.KEYCODE_META_LEFT, 101))
        assertFalse(up(KeyEvent.KEYCODE_CTRL_LEFT, 102))
        assertTrue(filter.isListening)
    }

    @Test
    fun `the command chord and Escape`() {
        assertFalse(down(KeyEvent.KEYCODE_SHIFT_LEFT, 0))
        assertTrue(down(KeyEvent.KEYCODE_META_LEFT, 1))
        assertEquals(listOf(HotkeyAction.Start(DictationMode.COMMAND)), taken())
        assertTrue(down(KeyEvent.KEYCODE_ESCAPE, 300))
        assertEquals(listOf(HotkeyAction.Cancel), taken())
        assertTrue(up(KeyEvent.KEYCODE_ESCAPE, 320))
        assertTrue(up(KeyEvent.KEYCODE_META_LEFT, 400))
        assertFalse(up(KeyEvent.KEYCODE_SHIFT_LEFT, 410))
        assertFalse(filter.isListening)
        // Escape when nothing is listening belongs to the app.
        assertFalse(down(KeyEvent.KEYCODE_ESCAPE, 1000))
        assertFalse(up(KeyEvent.KEYCODE_ESCAPE, 1010))
    }

    @Test
    fun `a session started from the button is known to the filter and stopped by the chord`() {
        filter.syncSession(listening = true, mode = DictationMode.HANDS_FREE, now = 0)
        assertTrue(filter.isListening)
        down(KeyEvent.KEYCODE_CTRL_LEFT, 100)
        assertTrue(down(KeyEvent.KEYCODE_META_LEFT, 101))
        assertEquals(listOf(HotkeyAction.Stop), taken())
        // The button stopped a session the keys started: the filter forgets it too.
        down(KeyEvent.KEYCODE_CTRL_LEFT, 2000)
        down(KeyEvent.KEYCODE_META_LEFT, 2001)
        taken()
        filter.syncSession(listening = false, mode = null, now = 2500)
        assertFalse(filter.isListening)
    }

    @Test
    fun `a keyboard that goes away mid-chord is forgotten`() {
        down(KeyEvent.KEYCODE_CTRL_LEFT, 0)
        down(KeyEvent.KEYCODE_META_LEFT, 1)
        assertTrue(filter.anyKeyDown)
        filter.reset()
        assertFalse(filter.anyKeyDown)
        assertFalse(filter.isListening)
    }

    @Test
    fun `capturing takes every key, streams the chord and ends when all are released`() {
        val snapshots = ArrayList<ShortcutCapture>()
        filter.startCapture { snapshots += it }
        assertTrue(filter.isCapturing)
        assertEquals("Press your shortcut…", snapshots.single().label)

        assertTrue(down(KeyEvent.KEYCODE_CTRL_LEFT, 0))
        assertTrue(down(KeyEvent.KEYCODE_META_LEFT, 10))
        assertEquals(listOf(Key.CTRL, Key.META), snapshots.last().keys)
        assertEquals("Ctrl + Meta", snapshots.last().label)
        assertFalse(snapshots.last().final)
        assertEquals("no session starts while capturing", emptyList<HotkeyAction>(), taken())

        assertTrue(up(KeyEvent.KEYCODE_META_LEFT, 100))
        assertTrue(up(KeyEvent.KEYCODE_CTRL_LEFT, 110))
        val final = snapshots.last()
        assertTrue(final.final)
        assertTrue(final.valid)
        assertEquals(listOf(Key.CTRL, Key.META), final.keys)
        assertFalse(filter.isCapturing)
    }

    @Test
    fun `capturing refuses a reserved chord and Escape cancels`() {
        var last: ShortcutCapture? = null
        filter.startCapture { last = it }
        down(KeyEvent.KEYCODE_CTRL_LEFT, 0)
        down(KeyEvent.KEYCODE_C, 10)
        up(KeyEvent.KEYCODE_C, 50)
        up(KeyEvent.KEYCODE_CTRL_LEFT, 60)
        assertNotNull(last)
        assertTrue(last!!.final)
        assertFalse(last!!.valid)
        assertTrue(last!!.reason!!, last!!.reason!!.contains("Ctrl + C"))

        filter.startCapture { last = it }
        assertTrue(down(KeyEvent.KEYCODE_ESCAPE, 100))
        assertTrue(last!!.final)
        assertEquals("Cancelled", last!!.reason)
        assertFalse(filter.isCapturing)
        assertTrue(up(KeyEvent.KEYCODE_ESCAPE, 110))
    }

    @Test
    fun `Back during a capture cancels it and still reaches the system`() {
        var last: ShortcutCapture? = null
        filter.startCapture { last = it }
        assertFalse(down(KeyEvent.KEYCODE_BACK, 0))
        assertEquals("Cancelled", last!!.reason)
        assertFalse(filter.isCapturing)
        assertFalse(up(KeyEvent.KEYCODE_BACK, 10))
        assertNull(taken().firstOrNull())
    }
}
