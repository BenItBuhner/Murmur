package app.murmur.android

import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayGeometry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
        assertEquals(540f, OverlayGeometry.snapX(540f + 10f, screenW, density), 0.01f)
        assertEquals(540f, OverlayGeometry.snapX(540f - OverlayGeometry.SNAP_DP * density, screenW, density), 0.01f)
        assertEquals(400f, OverlayGeometry.snapX(400f, screenW, density), 0.01f)
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
    fun `clampCenter keeps a segment inside its bounds`() {
        assertEquals(60f, OverlayGeometry.clampCenter(10f, 100f, 1000f, 10f), 0.01f)
        assertEquals(940f, OverlayGeometry.clampCenter(2000f, 100f, 1000f, 10f), 0.01f)
        assertEquals(500f, OverlayGeometry.clampCenter(500f, 100f, 1000f, 10f), 0.01f)
        assertEquals(500f, OverlayGeometry.clampCenter(0f, 2000f, 1000f, 10f), 0.01f)
    }
}
