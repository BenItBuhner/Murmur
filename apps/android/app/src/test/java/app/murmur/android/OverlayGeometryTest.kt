package app.murmur.android

import app.murmur.android.overlay.Box
import app.murmur.android.overlay.FlingTracker
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayGeometry
import app.murmur.android.overlay.Spring
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/** Layout maths for the floating pill: a 1080 x 2400 px screen at 3x with the keyboard's top edge at 1500 px. */
class OverlayGeometryTest {
    private val density = 3f
    private val screenW = 1080f
    private val screenH = 2400f
    private val keyboardTop = 1500f
    private val margin = OverlayGeometry.EDGE_MARGIN_DP * density

    @Test
    fun `default anchor centres the button 30 dp above the keyboard`() {
        val (x, y) = OverlayGeometry.anchorPoint(OverlayAnchor.DEFAULT, screenW, screenH, keyboardTop, density, 64 * density, 36 * density)
        assertEquals(540f, x, 0.01f)
        assertEquals(1500f - 30f * density, y, 0.01f)
    }

    @Test
    fun `negative offsets sit over the keyboard, e g on its toolbar`() {
        val (_, y) = OverlayGeometry.anchorPoint(OverlayAnchor(0.5f, -20f), screenW, screenH, keyboardTop, density, 108f, 108f)
        assertEquals(1500f + 20f * density, y, 0.01f)
    }

    @Test
    fun `without a keyboard the offset is measured from a resting line near the bottom`() {
        val (_, y) = OverlayGeometry.anchorPoint(OverlayAnchor.DEFAULT, screenW, screenH, null, density, 108f, 108f)
        assertEquals(screenH - (OverlayGeometry.NO_KEYBOARD_BASELINE_DP + 30f) * density, y, 0.01f)
        // A zero-height keyboard window is treated as absent too.
        val (_, y2) = OverlayGeometry.anchorPoint(OverlayAnchor.DEFAULT, screenW, screenH, 0f, density, 108f, 108f)
        assertEquals(y, y2, 0.01f)
    }

    @Test
    fun `the button never leaves the screen`() {
        val w = 108f
        val (leftX, _) = OverlayGeometry.anchorPoint(OverlayAnchor(0f, 30f), screenW, screenH, keyboardTop, density, w, w)
        assertEquals(margin + w / 2, leftX, 0.01f)
        val (rightX, _) = OverlayGeometry.anchorPoint(OverlayAnchor(1f, 30f), screenW, screenH, keyboardTop, density, w, w)
        assertEquals(screenW - margin - w / 2, rightX, 0.01f)
        val (_, topY) = OverlayGeometry.anchorPoint(OverlayAnchor(0.5f, 5000f), screenW, screenH, keyboardTop, density, w, w)
        assertEquals(margin + w / 2, topY, 0.01f)
        val (_, bottomY) = OverlayGeometry.anchorPoint(OverlayAnchor(0.5f, -5000f), screenW, screenH, keyboardTop, density, w, w)
        assertEquals(screenH - margin - w / 2, bottomY, 0.01f)
    }

    @Test
    fun `a wide pill anchored at the left edge grows to the right`() {
        val listeningW = 232 * density
        val box = OverlayGeometry.place(margin + 54f, 1400f, listeningW, 46 * density, screenW, screenH, density)
        assertEquals(margin, box.left, 0.01f)
        assertEquals(margin + listeningW, box.right, 0.01f)
        assertEquals(1400f, box.centerY, 0.01f)
    }

    @Test
    fun `a wide pill anchored at the right edge grows to the left`() {
        val listeningW = 232 * density
        val box = OverlayGeometry.place(screenW - margin - 54f, 1400f, listeningW, 46 * density, screenW, screenH, density)
        assertEquals(screenW - margin, box.right, 0.01f)
        assertEquals(screenW - margin - listeningW, box.left, 0.01f)
    }

    @Test
    fun `a centred pill stays centred`() {
        val box = OverlayGeometry.place(540f, 1400f, 300f, 100f, screenW, screenH, density)
        assertEquals(540f, box.centerX, 0.01f)
        assertEquals(1400f, box.centerY, 0.01f)
    }

    @Test
    fun `a pill wider than the screen is centred instead of clamped`() {
        val box = OverlayGeometry.place(100f, 1400f, screenW + 200f, 100f, screenW, screenH, density)
        assertEquals(screenW / 2f, box.centerX, 0.01f)
    }

    @Test
    fun `anchorFor is the inverse of anchorPoint`() {
        val anchors = listOf(OverlayAnchor.DEFAULT, OverlayAnchor(0.12f, -22f), OverlayAnchor(0.87f, 140f), OverlayAnchor(0.5f, 0f))
        for (a in anchors) {
            val (x, y) = OverlayGeometry.anchorPoint(a, screenW, screenH, keyboardTop, density, 108f, 108f)
            val back = OverlayGeometry.anchorFor(x, y, screenW, screenH, keyboardTop, density)
            assertEquals(a.xFraction, back.xFraction, 0.0001f)
            assertEquals(a.offsetDp, back.offsetDp, 0.001f)
        }
    }

    @Test
    fun `anchorFor without a keyboard uses the same resting line as anchorPoint`() {
        val a = OverlayAnchor(0.3f, 44f)
        val (x, y) = OverlayGeometry.anchorPoint(a, screenW, screenH, null, density, 108f, 108f)
        val back = OverlayGeometry.anchorFor(x, y, screenW, screenH, null, density)
        assertEquals(a.xFraction, back.xFraction, 0.0001f)
        assertEquals(a.offsetDp, back.offsetDp, 0.001f)
    }

    @Test
    fun `dragging near the middle snaps to it`() {
        val guides = listOf(screenW / 2f)
        val near = OverlayGeometry.snapToGuides(540f + 10f, 1400f, guides, emptyList(), density)
        assertEquals(540f, near.x, 0.01f)
        assertEquals(540f, near.guideX!!, 0.01f)
        assertEquals(1400f, near.y, 0.01f)
        assertNull(near.guideY)
        val edge = OverlayGeometry.snapToGuides(540f - OverlayGeometry.SNAP_DP * density, 1400f, guides, emptyList(), density)
        assertEquals(540f, edge.x, 0.01f)
        val far = OverlayGeometry.snapToGuides(400f, 1400f, guides, emptyList(), density)
        assertEquals(400f, far.x, 0.01f)
        assertNull(far.guideX)
    }

    @Test
    fun `guides snap each axis independently to the nearest candidate`() {
        // Another spot's column at x=300 and rows at y=1200 and y=1300.
        val snap = OverlayGeometry.snapToGuides(310f, 1290f, listOf(screenW / 2f, 300f), listOf(1200f, 1300f), density)
        assertEquals(300f, snap.x, 0.01f)
        assertEquals(300f, snap.guideX!!, 0.01f)
        assertEquals(1300f, snap.y, 0.01f)
        assertEquals(1300f, snap.guideY!!, 0.01f)
        // Only one axis within reach.
        val onlyY = OverlayGeometry.snapToGuides(700f, 1205f, listOf(screenW / 2f, 300f), listOf(1200f), density)
        assertEquals(700f, onlyY.x, 0.01f)
        assertNull(onlyY.guideX)
        assertEquals(1200f, onlyY.y, 0.01f)
    }

    @Test
    fun `a released drag lands on the nearest spot`() {
        val spots = listOf(540f to 1400f, 1000f to 1400f, 540f to 900f)
        assertEquals(0, OverlayGeometry.nearestSpot(spots, 600f, 1380f))
        assertEquals(1, OverlayGeometry.nearestSpot(spots, 900f, 1450f))
        assertEquals(2, OverlayGeometry.nearestSpot(spots, 500f, 1000f))
    }

    @Test
    fun `a flick reaches the spot the finger was heading for`() {
        val spots = listOf(540f to 1400f, 1000f to 1400f)
        // Released just past the middle but moving right fast: 2500 px/s * 0.12 s looks 300 px ahead.
        assertEquals(1, OverlayGeometry.nearestSpot(spots, 600f, 1400f, vx = 2500f, vy = 0f))
        // The same release point at rest stays on the first spot.
        assertEquals(0, OverlayGeometry.nearestSpot(spots, 600f, 1400f))
        // The look-ahead is capped so a wild fling does not sail past the intended spot.
        val row = listOf(200f to 1400f, 540f to 1400f, 900f to 1400f)
        assertEquals(1, OverlayGeometry.nearestSpot(row, 250f, 1400f, vx = 9000f, vy = 0f, maxLookaheadPx = 300f))
        assertEquals(2, OverlayGeometry.nearestSpot(row, 250f, 1400f, vx = 9000f, vy = 0f))
    }

    @Test
    fun `the spring lands quickly with only a hint of overshoot`() {
        val spring = Spring(position = 0f).apply { target = 300f }
        var elapsed = 0L
        var peak = 0f
        while (!spring.settled && elapsed < 2000L) {
            spring.advance(16L)
            elapsed += 16L
            peak = maxOf(peak, spring.position)
        }
        assertTrue("settled in $elapsed ms", spring.settled && elapsed <= 600L)
        assertEquals(300f, spring.position, 0.001f)
        assertTrue("overshoot ${peak - 300f}", peak - 300f < 300f * 0.06f)
        // Any frame rate ends in the same place.
        val coarse = Spring(position = 0f).apply { target = 300f }
        repeat(40) { coarse.advance(50L) }
        assertTrue(coarse.settled)
    }

    @Test
    fun `the spring carries the velocity a drag left it with`() {
        val thrown = Spring(position = 0f, velocity = 1500f).apply { target = 100f }
        thrown.advance(50L)
        val still = Spring(position = 0f).apply { target = 100f }
        still.advance(50L)
        assertTrue(thrown.position > still.position)
        // A throw away from the target first travels away, then comes back.
        val away = Spring(position = 0f, velocity = -1500f).apply { target = 100f }
        away.advance(30L)
        assertTrue(away.position < 0f)
        repeat(60) { away.advance(16L) }
        assertTrue(abs(away.position - 100f) < 0.01f)
    }

    @Test
    fun `the fling tracker measures the last hundred milliseconds only`() {
        val tracker = FlingTracker()
        assertEquals(0f to 0f, tracker.velocity())
        tracker.add(0L, 0f, 0f)
        tracker.add(50L, 100f, 0f)
        tracker.add(100L, 200f, 50f)
        val (vx, vy) = tracker.velocity()
        assertEquals(2000f, vx, 0.01f)
        assertEquals(500f, vy, 0.01f)
        // Holding still before letting go is not a fling.
        tracker.add(400L, 200f, 50f)
        assertEquals(0f to 0f, tracker.velocity())
        tracker.reset()
        tracker.add(0L, 0f, 0f)
        assertEquals(0f to 0f, tracker.velocity())
    }

    @Test
    fun `rounded anchors drop float noise but keep precision that matters`() {
        val r = OverlayAnchor(0.123456f, -17.987f).rounded()
        assertEquals(0.1235f, r.xFraction, 0.000001f)
        assertEquals(-17.99f, r.offsetDp, 0.000001f)
        assertEquals(OverlayAnchor.DEFAULT, OverlayAnchor.DEFAULT.rounded())
    }

    @Test
    fun `boxes union, inflate, intersect and compare`() {
        val a = Box(10f, 10f, 50f, 30f)
        val b = Box(40f, 0f, 80f, 20f)
        assertEquals(Box(10f, 0f, 80f, 30f), a.union(b))
        assertEquals(Box(5f, 5f, 55f, 35f), a.inflate(5f))
        assertEquals(Box(40f, 10f, 50f, 20f), a.intersect(b))
        assertEquals(Box(0f, 10f, 40f, 30f), a.offset(-10f, 0f).intersect(Box(0f, 0f, 100f, 100f)))
        assertEquals(Box(0f, 10f, 30f, 30f), a.offset(-20f, 0f).intersect(Box(0f, 0f, 100f, 100f)))
        assertTrue(a.contains(10f, 30f))
        assertFalse(a.contains(51f, 20f))
        assertTrue(a.approximately(Box(10.2f, 9.8f, 50.1f, 30.3f)))
        assertFalse(a.approximately(Box(11f, 10f, 50f, 30f)))
        assertEquals(30f, Box.centered(30f, 20f, 10f, 10f).centerX, 0.01f)
    }

    @Test
    fun `a box encloses what lies inside it, with a little slack`() {
        val a = Box(10f, 10f, 50f, 30f)
        assertTrue(a.encloses(a))
        assertTrue(a.encloses(Box(20f, 12f, 40f, 28f)))
        assertTrue(a.encloses(Box(9.7f, 10f, 50.3f, 30f)))
        assertFalse(a.encloses(Box(9f, 10f, 50f, 30f)))
        assertFalse(a.encloses(Box(10f, 10f, 50f, 31f)))
        assertFalse(a.encloses(a.union(Box(0f, 0f, 5f, 5f))))
    }

    @Test
    fun `clampCenter keeps a segment inside its bounds`() {
        assertEquals(60f, OverlayGeometry.clampCenter(10f, 100f, 1000f, 10f), 0.01f)
        assertEquals(940f, OverlayGeometry.clampCenter(2000f, 100f, 1000f, 10f), 0.01f)
        assertEquals(500f, OverlayGeometry.clampCenter(500f, 100f, 1000f, 10f), 0.01f)
        assertEquals(500f, OverlayGeometry.clampCenter(0f, 2000f, 1000f, 10f), 0.01f)
    }
}
