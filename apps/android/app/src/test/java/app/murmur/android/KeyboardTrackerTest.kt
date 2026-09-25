package app.murmur.android

import app.murmur.android.overlay.Box
import app.murmur.android.service.ImeWindow
import app.murmur.android.service.KeyboardTracker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val W = 1080f
private const val H = 2400f
private const val REST = 1500f

/**
 * The keyboard as the pill needs it, from window lists that report it late and mid-slide: while
 * it arrives the pill already measures from where it will rest; afterwards it follows what the
 * list reports; a keyboard carried off by a system animation, or gone, is not there.
 */
class KeyboardTrackerTest {

    private val tracker = KeyboardTracker(density = 3f)

    private fun ime(reportedTop: Float, frameTop: Float? = REST, id: Int = 7, left: Float = 0f, right: Float = W) =
        ImeWindow(id, Box(left, reportedTop, right, H), frameTop?.let { Box(0f, it, W, H) })

    @Test
    fun `a keyboard reported part of the way up is measured from where it comes to rest`() {
        assertTrue(tracker.update(ime(reportedTop = 2100f), nowMs = 0))
        assertTrue(tracker.visible)
        assertEquals(REST.toInt(), tracker.top)
        assertNotNull(tracker.arrivalDeadline)
        // Later snapshots of the slide do not move it.
        assertFalse(tracker.update(ime(reportedTop = 1700f), nowMs = 40))
        assertEquals(REST.toInt(), tracker.top)
        // At rest the report agrees, and the arrival is over.
        tracker.update(ime(reportedTop = REST), nowMs = 190)
        assertEquals(REST.toInt(), tracker.top)
        assertNull(tracker.arrivalDeadline)
    }

    @Test
    fun `once at rest it follows what the list reports`() {
        tracker.update(ime(reportedTop = REST), nowMs = 0)
        // An app drags the keyboard down with a scroll, then lets it spring back.
        assertTrue(tracker.update(ime(reportedTop = REST + 60f), nowMs = 600))
        assertEquals((REST + 60f).toInt(), tracker.top)
        tracker.update(ime(reportedTop = REST), nowMs = 700)
        assertEquals(REST.toInt(), tracker.top)
        // The keyboard grows a row: its frame and its report move together.
        tracker.update(ime(reportedTop = REST - 130f, frameTop = REST - 130f), nowMs = 900)
        assertEquals((REST - 130f).toInt(), tracker.top)
    }

    @Test
    fun `a drag in progress when the keyboard leaves does not skew the next arrival`() {
        tracker.update(ime(reportedTop = REST), nowMs = 0)
        tracker.update(ime(reportedTop = REST + 40f), nowMs = 900)
        tracker.update(null, nowMs = 1000)
        tracker.update(ime(reportedTop = 2100f), nowMs = 2000)
        assertEquals(REST.toInt(), tracker.top)
    }

    @Test
    fun `a keyboard whose touch area starts below its frame is learned once and then placed exactly`() {
        // First sighting: the report is 15 px under the frame; the tracker cannot tell that from a slide.
        tracker.update(ime(reportedTop = 2000f), nowMs = 0)
        assertEquals(REST.toInt(), tracker.top)
        tracker.update(ime(reportedTop = REST + 15f), nowMs = 200)
        // Past the longest slide, the report is trusted and the offset remembered.
        tracker.update(ime(reportedTop = REST + 15f), nowMs = 460)
        assertEquals((REST + 15f).toInt(), tracker.top)
        tracker.update(null, nowMs = 2000)
        assertFalse(tracker.visible)
        // Next time it arrives, the pill measures from the right edge from the first report.
        tracker.update(ime(reportedTop = 2100f), nowMs = 3000)
        assertEquals((REST + 15f).toInt(), tracker.top)
        tracker.update(ime(reportedTop = REST + 15f), nowMs = 3180)
        assertEquals((REST + 15f).toInt(), tracker.top)
        assertNull(tracker.arrivalDeadline)
    }

    @Test
    fun `without its frame the report is used as it is`() {
        tracker.update(ime(reportedTop = 1800f, frameTop = null), nowMs = 0)
        assertTrue(tracker.visible)
        assertEquals(1800, tracker.top)
        assertNull(tracker.arrivalDeadline)
    }

    @Test
    fun `a keyboard that leaves is gone at once and its last edge is kept`() {
        tracker.update(ime(reportedTop = REST), nowMs = 0)
        assertTrue(tracker.update(null, nowMs = 500))
        assertFalse(tracker.visible)
        assertEquals(REST.toInt(), tracker.top)
        assertFalse(tracker.update(null, nowMs = 520))
    }

    @Test
    fun `a keyboard scaled down with the app for Recents counts as gone`() {
        tracker.update(ime(reportedTop = REST), nowMs = 0)
        assertTrue(tracker.update(ime(reportedTop = 1200f, left = 140f, right = 940f), nowMs = 800))
        assertFalse(tracker.visible)
        // Back from Recents at full width: there again.
        tracker.update(ime(reportedTop = REST), nowMs = 1600)
        assertTrue(tracker.visible)
    }

    @Test
    fun `a zero-height keyboard window does not count`() {
        assertFalse(tracker.update(ime(reportedTop = H - 20f, frameTop = H - 20f), nowMs = 0))
        assertFalse(tracker.visible)
    }
}
