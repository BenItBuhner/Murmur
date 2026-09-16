package app.murmur.android

import app.murmur.android.overlay.DisplayGeometry
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayArrangement
import app.murmur.android.overlay.OverlayDefaults
import app.murmur.android.overlay.OverlayGeometry
import app.murmur.android.overlay.OverlayLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/** The resting pill: 64 x 36 dp, so a capsule of radius 18 dp. */
private const val PILL_W = OverlayGeometry.RESTING_W_DP
private const val PILL_H = OverlayGeometry.RESTING_H_DP
private const val PILL_R = PILL_H / 2f

/**
 * Galaxy S26 Ultra: 1440 x 3120 at 498 ppi, rendered at 384 x 832 dp (2340 x 1080 at 450 dpi out of
 * the box, 3120 x 1440 at 600 dpi in QHD+). Samsung does not publish the radius One UI reports for
 * the display's corners; 28 dp is the radius at which a pill 11 % from the left is concentric with it.
 */
private val S26_ULTRA = DisplayGeometry(widthDp = 384f, heightDp = 832f, cornerRadiusDp = 28f, model = "SM-S948B")

/** Pixel 9: 1080 x 2424 at 2.625x (411 x 923 dp). The Pixel family declares ~35 dp corners (Pixel 8 Pro: 115 px at 3.25x). */
private val PIXEL_9 = DisplayGeometry(widthDp = 1080f / 2.625f, heightDp = 2424f / 2.625f, cornerRadiusDp = 92f / 2.625f, model = "Pixel 9")

/** A small, square-cornered phone: 480 x 854 at hdpi (320 x 569 dp), nothing reported for its corners. */
private val SMALL_PHONE = DisplayGeometry(widthDp = 320f, heightDp = 569.33f, cornerRadiusDp = 0f, model = "SM-A015F")

/** The keyboard the S26 Ultra spots were tuned with: an IME window 347 dp tall (323 = 347 - 6 - 18). */
private const val S26_KEYBOARD_DP = 347f

/**
 * The spots a device starts with: the Galaxy S26 Ultra's hand-tuned pair on that model, and the
 * same two spots derived from the display's own geometry everywhere else.
 */
class OverlayDefaultsTest {

    @Test
    fun `every Galaxy S26 Ultra variant is pinned to the hand-tuned spots`() {
        val variants = listOf("SM-S948B", "SM-S948B/DS", "SM-S948U", "SM-S948U1", "SM-S948W", "SM-S948N", "SM-S9480", "SM-S948E", "SM-S948E/DS")
        for (model in variants) {
            val pinned = OverlayDefaults.pinnedFor(model)
            assertSame("$model should be pinned", OverlayLayout.DEFAULT, pinned)
            assertSame(OverlayLayout.DEFAULT, OverlayDefaults.layoutFor(S26_ULTRA.copy(model = model)))
        }
        // Whatever Build.MODEL's casing or padding.
        assertSame(OverlayLayout.DEFAULT, OverlayDefaults.pinnedFor(" sm-s948b "))
    }

    @Test
    fun `the pinned spots are exactly 11 percent from the left, 323 dp over, and centred 25 dp above`() {
        val pinned = OverlayDefaults.pinnedFor("SM-S948U1")!!
        assertEquals(listOf(OverlayAnchor(0.11f, -323f), OverlayAnchor(0.5f, 25f)), pinned.spots)
        assertEquals(0, pinned.activeIndex)
        assertEquals(OverlayArrangement.FREE, pinned.arrangement)
        assertEquals("11% from the left, 323 dp down over the keyboard", pinned.spots[0].describe())
        assertEquals("Centred, 25 dp above the keyboard", pinned.spots[1].describe())
    }

    @Test
    fun `other models are not pinned`() {
        for (model in listOf("SM-S938B", "SM-S9380", "SM-S947B", "Pixel 9", "SM-A015F", "", "   ", null)) {
            assertNull("$model should not be pinned", OverlayDefaults.pinnedFor(model))
        }
        assertNotEquals(OverlayLayout.DEFAULT, OverlayDefaults.layoutFor(PIXEL_9))
    }

    @Test
    fun `a derived layout is two free spots, the corner first`() {
        val layout = OverlayDefaults.derive(PIXEL_9)
        assertEquals(2, layout.spots.size)
        assertEquals(0, layout.activeIndex)
        assertEquals(OverlayArrangement.FREE, layout.arrangement)
        assertEquals(OverlayAnchor(0.5f, 25f), layout.spots[1])
        assertEquals(OverlayDefaults.cornerSpot(PIXEL_9), layout.spots[0])
    }

    @Test
    fun `the corner spot is concentric with the display's rounded corner`() {
        for (geometry in listOf(S26_ULTRA, PIXEL_9)) {
            val spot = OverlayDefaults.cornerSpot(geometry)
            // The pill's left edge sits (R - r) in from the display's edge, so its corner arc's centre
            // is R in from the edge: the same point the display's corner turns around.
            val inset = geometry.cornerRadiusDp - PILL_R
            val leftEdgeDp = spot.xFraction * geometry.widthDp - PILL_W / 2f
            assertEquals("${geometry.model} left edge", inset, leftEdgeDp, 0.05f)
            assertEquals("${geometry.model} arc centre", geometry.cornerRadiusDp, leftEdgeDp + PILL_R, 0.05f)
            // Its depth is measured from the top of the display, so it reaches the corner from under any keyboard.
            assertEquals("${geometry.model} depth", -(geometry.heightDp - inset - PILL_R), spot.offsetDp, 0.5f)
        }
    }

    @Test
    fun `on Galaxy S26 Ultra metrics the rule reproduces the hand-tuned 11 percent but not the 323 dp`() {
        val derived = OverlayDefaults.cornerSpot(S26_ULTRA)
        // 28 dp corner: (28 - 18 + 32) / 384 = 0.1094, which describe() reads as "11% from the left".
        assertEquals(0.11f, derived.xFraction, 0.002f)
        assertEquals("11% from the left", derived.describe().substringBefore(","))
        // The 323 dp encodes the keyboard the spot was tuned with; the rule reaches for the corner from the top of the display instead.
        assertEquals(-(832f - 10f - 18f), derived.offsetDp, 0.5f)
        assertNotEquals(-323f, derived.offsetDp)
    }

    @Test
    fun `on Galaxy S26 Ultra with its keyboard up the rule and the pin park the button on the same pixel`() {
        // FHD+ rendering: 1080 x 2340 px at 2.8125x, the keyboard's top edge 347 dp above the bottom.
        val density = 2.8125f
        val screenW = 1080f
        val screenH = 2340f
        val keyboardTop = screenH - S26_KEYBOARD_DP * density
        val pinned = OverlayLayout.DEFAULT.spots[0]
        val derived = OverlayDefaults.cornerSpot(S26_ULTRA)
        val (px, py) = OverlayGeometry.anchorPoint(pinned, screenW, screenH, keyboardTop, density, PILL_W * density, PILL_H * density)
        val (dx, dy) = OverlayGeometry.anchorPoint(derived, screenW, screenH, keyboardTop, density, PILL_W * density, PILL_H * density)
        assertEquals(px, dx, 1f)
        assertEquals(py, dy, 1f)
        // Both rest on the bottom margin: the button's bottom edge 6 dp above the screen's.
        assertEquals(screenH - (OverlayGeometry.EDGE_MARGIN_DP + PILL_R) * density, py, 1f)
        // A taller keyboard (a number row, say) lifts the hand-tuned spot with it; the derived one stays in the corner.
        val tallerKeyboardTop = screenH - (S26_KEYBOARD_DP + 40f) * density
        val (_, liftedPinned) = OverlayGeometry.anchorPoint(pinned, screenW, screenH, tallerKeyboardTop, density, PILL_W * density, PILL_H * density)
        val (_, stillCornered) = OverlayGeometry.anchorPoint(derived, screenW, screenH, tallerKeyboardTop, density, PILL_W * density, PILL_H * density)
        assertTrue(liftedPinned < py - 30f * density)
        assertEquals(py, stillCornered, 0.01f)
    }

    @Test
    fun `on a Pixel 9 the corner spot sits 17 dp in and reaches the corner`() {
        val spot = OverlayDefaults.cornerSpot(PIXEL_9)
        // 35 dp corner less the 18 dp pill radius: 17 dp in, centre 49 dp from the left of 411 dp.
        assertEquals(17.05f, PIXEL_9.cornerRadiusDp - PILL_R, 0.01f)
        assertEquals((17.05f + 32f) / (1080f / 2.625f), spot.xFraction, 0.0002f)
        assertEquals("12% from the left", spot.describe().substringBefore(","))
        // Rendered at 1080 x 2424 px with Gboard's top edge 1600 px down: the pill's left edge is R - r in, its bottom on the margin.
        val density = 2.625f
        val (x, y) = OverlayGeometry.anchorPoint(spot, 1080f, 2424f, 1600f, density, PILL_W * density, PILL_H * density)
        assertEquals(17.05f * density, x - PILL_W / 2f * density, 0.5f)
        assertEquals(2424f - (OverlayGeometry.EDGE_MARGIN_DP + PILL_R) * density, y, 0.01f)
    }

    @Test
    fun `a small square-cornered phone falls back to the edge margin`() {
        val spot = OverlayDefaults.cornerSpot(SMALL_PHONE)
        // No corner to be concentric with: the usual 6 dp margin, centre 38 dp from the left of 320 dp.
        assertEquals((OverlayGeometry.EDGE_MARGIN_DP + PILL_W / 2f) / 320f, spot.xFraction, 0.0002f)
        assertEquals("12% from the left", spot.describe().substringBefore(","))
        assertEquals(-(569f - 6f - 18f), spot.offsetDp, 0.5f)
        // A corner tighter than the pill's own would pull it off the screen; the margin holds.
        val tight = OverlayDefaults.cornerSpot(SMALL_PHONE.copy(cornerRadiusDp = 12f))
        assertEquals(spot.xFraction, tight.xFraction, 0.00001f)
        // And it lands exactly where the clamp would put a button dragged into the corner.
        val density = 1.5f
        val (x, y) = OverlayGeometry.anchorPoint(spot, 480f, 854f, 500f, density, PILL_W * density, PILL_H * density)
        assertEquals(OverlayGeometry.clampCenter(0f, PILL_W * density, 480f, OverlayGeometry.EDGE_MARGIN_DP * density), x, 0.5f)
        assertEquals(OverlayGeometry.clampCenter(9999f, PILL_H * density, 854f, OverlayGeometry.EDGE_MARGIN_DP * density), y, 0.01f)
    }

    @Test
    fun `derived spots are rounded like edited ones and never leave the screen`() {
        for (geometry in listOf(S26_ULTRA, PIXEL_9, SMALL_PHONE)) {
            val spot = OverlayDefaults.cornerSpot(geometry)
            assertEquals(spot, spot.rounded())
            assertEquals(spot.offsetDp, Math.round(spot.offsetDp).toFloat(), 0f)
            assertTrue(spot.xFraction in 0f..0.5f)
            assertTrue(abs(spot.offsetDp) <= geometry.heightDp)
        }
    }

    @Test
    fun `default spots read in plain words in the Spots list, moved ones by their numbers`() {
        // Pinned (Galaxy S26 Ultra) and derived (Pixel 9) alike: the corner spot in words, the centred one by its numbers.
        val pinned = OverlayDefaults.layoutFor(S26_ULTRA)
        assertEquals("Bottom-left corner, over the keyboard", OverlayDefaults.describe(pinned.spots[0], pinned))
        assertEquals("Centred, 25 dp above the keyboard", OverlayDefaults.describe(pinned.spots[1], pinned))
        val derived = OverlayDefaults.layoutFor(PIXEL_9)
        assertEquals("Bottom-left corner, over the keyboard", OverlayDefaults.describe(derived.spots[0], derived))
        assertEquals("Centred, 25 dp above the keyboard", OverlayDefaults.describe(derived.spots[1], derived))
        // The moment a spot is moved, a 1 dp nudge included, it reads by its numbers again.
        val nudged = derived.moved(0, derived.spots[0].copy(offsetDp = derived.spots[0].offsetDp + 1f))
        assertEquals("12% from the left, 887 dp down over the keyboard", OverlayDefaults.describe(nudged.spots[0], derived))
        val dragged = pinned.moved(0, OverlayAnchor(0.9f, -20f))
        assertEquals("10% from the right, 20 dp down over the keyboard", OverlayDefaults.describe(dragged.spots[0], pinned))
        // Moving the other spot leaves the corner spot's words alone.
        val otherMoved = pinned.moved(1, OverlayAnchor(0.5f, 40f))
        assertEquals("Bottom-left corner, over the keyboard", OverlayDefaults.describe(otherMoved.spots[0], pinned))
        assertEquals("Centred, 40 dp above the keyboard", OverlayDefaults.describe(otherMoved.spots[1], pinned))
        // It is the spot that is untouched, not its slot: reordered, it keeps its words.
        val reordered = OverlayLayout(listOf(pinned.spots[1], pinned.spots[0]))
        assertEquals("Bottom-left corner, over the keyboard", OverlayDefaults.describe(reordered.spots[1], pinned))
        // Another device's corner spot is not this device's default.
        assertEquals("11% from the left, 323 dp down over the keyboard", OverlayDefaults.describe(pinned.spots[0], derived))
        // Should the rule ever put the corner spot on the other side, the words follow.
        assertEquals("Bottom-right corner, over the keyboard", OverlayDefaults.cornerLabel(OverlayAnchor(0.89f, -804f)))
    }

    @Test
    fun `a display that could not be measured gets the preferred spots`() {
        assertSame(OverlayLayout.DEFAULT, OverlayDefaults.derive(DisplayGeometry(0f, 0f, 0f, "")))
        assertSame(OverlayLayout.DEFAULT, OverlayDefaults.layoutFor(DisplayGeometry(0f, 800f, 30f, "unknown")))
    }
}
