package app.murmur.android

import app.murmur.android.overlay.Box
import app.murmur.android.service.ImeWindow
import app.murmur.android.service.KeyboardTracker
import app.murmur.android.service.MemoryKeyboardOffsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val W = 1080f
private const val H = 2400f
private const val REST = 1500f
private const val DENSITY = 3f
private const val KEYBOARD = "com.samsung.android.honeyboard"

/**
 * The keyboard as the pill needs it, from window lists that report it late and mid-slide: whether it
 * is there, whether where it rests is known ([KeyboardTracker.ready]), whether it has been pulled well
 * down ([KeyboardTracker.displaced]), and its resting edge, never a mid-slide one.
 */
class KeyboardTrackerTest {

    private val offsets = MemoryKeyboardOffsets()
    private val tracker = KeyboardTracker(DENSITY, offsets)

    private fun ime(reportedTop: Float, frameTop: Float? = REST, id: Int = 7, left: Float = 0f, right: Float = W) =
        ImeWindow(id, Box(left, reportedTop, right, H), frameTop?.let { Box(0f, it, W, H) }, KEYBOARD.takeIf { frameTop != null })

    private fun KeyboardTracker.feed(reportedTop: Float, nowMs: Long, frameTop: Float? = REST) = update(ime(reportedTop, frameTop), nowMs, H)

    @Test
    fun `a keyboard seen for the first time is not ready until it is reported at rest`() {
        assertTrue(tracker.feed(2100f, nowMs = 0))
        assertTrue(tracker.visible)
        assertFalse(tracker.ready)
        assertNotNull(tracker.arrivalDeadline)
        tracker.feed(1700f, nowMs = 40)
        assertFalse(tracker.ready)
        // Level with its frame: at rest, and its offset (none) learned.
        assertTrue(tracker.feed(REST, nowMs = 190))
        assertTrue(tracker.ready)
        assertFalse(tracker.displaced)
        assertEquals(REST.toInt(), tracker.top)
        assertNull(tracker.arrivalDeadline)
        assertEquals(0f, offsets[KEYBOARD])
    }

    @Test
    fun `a keyboard whose offset is known is ready from its first report, measured from where it will rest`() {
        offsets[KEYBOARD] = 15f
        tracker.feed(2100f, nowMs = 0)
        assertTrue(tracker.ready)
        assertEquals((REST + 15f).toInt(), tracker.top)
        // Later snapshots of the slide change nothing the pill reads.
        assertFalse(tracker.feed(1700f, nowMs = 40))
        tracker.feed(REST + 15f, nowMs = 190)
        assertEquals((REST + 15f).toInt(), tracker.top)
        assertNull(tracker.arrivalDeadline)
    }

    @Test
    fun `a keyboard whose touch area starts below its frame is learned once, remembered, and then placed exactly`() {
        // First sighting: reported sliding in, far below its frame; then at rest 15 px under it,
        // within what a keyboard at rest can be: ready on that report, with no timer.
        tracker.feed(2000f, nowMs = 0)
        assertFalse(tracker.ready)
        tracker.feed(REST + 15f, nowMs = 200)
        assertTrue(tracker.ready)
        assertEquals((REST + 15f).toInt(), tracker.top)
        assertEquals(15f, offsets[KEYBOARD])
        assertNull(tracker.arrivalDeadline)
        tracker.update(null, nowMs = 2000, screenH = H)
        assertFalse(tracker.visible)
        // Next time, and after a restart (a new tracker on the same store), ready from the first report.
        tracker.feed(2100f, nowMs = 3000)
        assertTrue(tracker.ready)
        assertEquals((REST + 15f).toInt(), tracker.top)
        val restarted = KeyboardTracker(DENSITY, offsets)
        restarted.feed(2100f, nowMs = 0)
        assertTrue(restarted.ready)
        assertEquals((REST + 15f).toInt(), restarted.top)
    }

    @Test
    fun `a keyboard resting higher than remembered takes that as its edge`() {
        offsets[KEYBOARD] = 15f
        tracker.feed(REST + 15f, nowMs = 0)
        tracker.feed(REST, nowMs = 600)
        assertEquals(REST.toInt(), tracker.top)
        assertEquals(0f, offsets[KEYBOARD])
    }

    @Test
    fun `a dip from an app's scroll leaves the resting edge alone, and a keyboard pulled well down is displaced until it is back`() {
        tracker.feed(REST, nowMs = 0)
        // About 30 dp: the recording's scroll dips.
        tracker.feed(REST + 90f, nowMs = 600)
        assertFalse(tracker.displaced)
        assertEquals(REST.toInt(), tracker.top)
        // Past 48 dp: leaving, or dragged most of the way out.
        assertTrue(tracker.feed(REST + 150f, nowMs = 700))
        assertTrue(tracker.displaced)
        assertEquals(REST.toInt(), tracker.top)
        // Still well down on the way back up: still displaced, until it is back at rest.
        tracker.feed(REST + 90f, nowMs = 800)
        assertTrue(tracker.displaced)
        tracker.feed(REST, nowMs = 900)
        assertFalse(tracker.displaced)
        assertTrue(tracker.ready)
    }

    @Test
    fun `the keyboard growing a row moves its resting edge`() {
        tracker.feed(REST, nowMs = 0)
        tracker.feed(REST - 130f, nowMs = 900, frameTop = REST - 130f)
        assertEquals((REST - 130f).toInt(), tracker.top)
        assertFalse(tracker.displaced)
    }

    @Test
    fun `a drag in progress when the keyboard leaves does not skew the next arrival`() {
        tracker.feed(REST, nowMs = 0)
        tracker.feed(REST + 150f, nowMs = 900)
        tracker.update(null, nowMs = 1000, screenH = H)
        assertFalse(tracker.displaced)
        tracker.feed(2100f, nowMs = 2000)
        assertTrue(tracker.ready)
        assertFalse(tracker.displaced)
        assertEquals(REST.toInt(), tracker.top)
    }

    @Test
    fun `without its frame the report is used once the arrival is over`() {
        tracker.feed(1800f, nowMs = 0, frameTop = null)
        assertTrue(tracker.visible)
        assertFalse(tracker.ready)
        assertNotNull(tracker.arrivalDeadline)
        tracker.feed(1800f, nowMs = 460, frameTop = null)
        assertTrue(tracker.ready)
        assertEquals(1800, tracker.top)
        assertNull(tracker.arrivalDeadline)
    }

    @Test
    fun `a keyboard that leaves is gone at once and its last resting edge is kept`() {
        tracker.feed(REST, nowMs = 0)
        assertTrue(tracker.update(null, nowMs = 500, screenH = H))
        assertFalse(tracker.visible)
        assertFalse(tracker.ready)
        assertEquals(REST.toInt(), tracker.top)
        assertFalse(tracker.update(null, nowMs = 520, screenH = H))
    }

    @Test
    fun `a keyboard lifted with the app for Recents counts as gone`() {
        tracker.feed(REST, nowMs = 0)
        // Swiping up shrinks the app card and lifts it, the keyboard inside it.
        assertTrue(tracker.update(ime(reportedTop = 1200f, left = 140f, right = 940f), nowMs = 800, screenH = H))
        assertFalse(tracker.visible)
        // Back in the app: there again, and ready at once.
        tracker.feed(REST, nowMs = 1600)
        assertTrue(tracker.visible)
        assertTrue(tracker.ready)
    }

    @Test
    fun `a floating keyboard in a full-screen window is taken where it is reported, once it has settled`() {
        tracker.update(ime(reportedTop = 900f, frameTop = 0f, left = 200f, right = 880f), nowMs = 0, screenH = H)
        assertTrue(tracker.visible)
        assertFalse(tracker.ready)
        tracker.update(ime(reportedTop = 900f, frameTop = 0f, left = 200f, right = 880f), nowMs = 460, screenH = H)
        assertTrue(tracker.ready)
        assertEquals(900, tracker.top)
    }

    @Test
    fun `a keyboard that appears without sliding, a little below its frame, is ready on its first report`() {
        tracker.feed(REST + 15f, nowMs = 0)
        assertTrue(tracker.ready)
        assertEquals((REST + 15f).toInt(), tracker.top)
        assertEquals(15f, offsets[KEYBOARD])
    }

    @Test
    fun `a keyboard resting well below its frame is waited for once, then known from its first report`() {
        // It settles 200 px (67 dp) under a docked frame: past what passes for at rest at once.
        tracker.feed(2000f, nowMs = 0, frameTop = 1300f)
        tracker.feed(REST, nowMs = 220, frameTop = 1300f)
        assertFalse(tracker.ready)
        tracker.feed(REST, nowMs = 460, frameTop = 1300f)
        assertTrue(tracker.ready)
        assertEquals(REST.toInt(), tracker.top)
        assertEquals(200f, offsets[KEYBOARD])
        tracker.update(null, nowMs = 1000, screenH = H)
        // Next time, even after a restart: its resting edge is known from the first report of it.
        val restarted = KeyboardTracker(DENSITY, offsets)
        restarted.feed(2000f, nowMs = 2000, frameTop = 1300f)
        assertTrue(restarted.ready)
        assertEquals(REST.toInt(), restarted.top)
    }

    @Test
    fun `a keyboard resting more than halfway down its window stops being placed by its frame`() {
        // A docked-looking frame 1100 px tall, but the keyboard settles 600 px down it.
        tracker.feed(2200f, nowMs = 0, frameTop = 1300f)
        tracker.feed(1900f, nowMs = 460, frameTop = 1300f)
        assertTrue(tracker.ready)
        assertEquals(1900, tracker.top)
        assertNull(offsets[KEYBOARD])
        tracker.update(null, nowMs = 1000, screenH = H)
        // Next time it is waited for like a keyboard without a frame, and taken where it settles.
        tracker.feed(2200f, nowMs = 2000, frameTop = 1300f)
        assertFalse(tracker.ready)
        tracker.feed(1900f, nowMs = 2460, frameTop = 1300f)
        assertTrue(tracker.ready)
        assertEquals(1900, tracker.top)
    }

    @Test
    fun `the first sliver of a keyboard sliding in counts, and a known keyboard is ready on it`() {
        offsets[KEYBOARD] = 15f
        // Its window has just appeared: 60 px of it in view, its frame the whole keyboard.
        assertTrue(tracker.feed(H - 60f, nowMs = 0))
        assertTrue(tracker.visible)
        assertTrue(tracker.ready)
        assertFalse(tracker.displaced)
        assertEquals((REST + 15f).toInt(), tracker.top)
        // Unknown, the same sliver is a keyboard on its way in, not yet placed.
        val fresh = KeyboardTracker(DENSITY, MemoryKeyboardOffsets())
        fresh.feed(H - 60f, nowMs = 0)
        assertTrue(fresh.visible)
        assertFalse(fresh.ready)
    }

    @Test
    fun `a zero-height keyboard window does not count`() {
        assertFalse(tracker.update(ime(reportedTop = H - 20f, frameTop = H - 20f), nowMs = 0, screenH = H))
        assertFalse(tracker.visible)
    }
}
