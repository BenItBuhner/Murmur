package app.murmur.android

import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayArrangement
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayLayoutCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rules for the spots the dictation button can be parked on. */
class OverlayLayoutTest {
    private val centre = OverlayAnchor(0.5f, 30f)
    private val right = OverlayAnchor(1f, 30f)
    private val toolbar = OverlayAnchor(0.9f, -20f)

    @Test
    fun `the default layout is two spots on one row above the keyboard`() {
        val d = OverlayLayout.DEFAULT
        assertEquals(listOf(centre, right), d.spots)
        assertEquals(0, d.activeIndex)
        assertEquals(OverlayArrangement.FREE, d.arrangement)
        assertTrue(d.isDefault)
        assertFalse(d.activated(1).isDefault)
    }

    @Test
    fun `a layout always has between one and four spots and a valid active index`() {
        assertTrue(runCatching { OverlayLayout(emptyList()) }.isFailure)
        assertTrue(runCatching { OverlayLayout(List(5) { centre }) }.isFailure)
        assertTrue(runCatching { OverlayLayout(listOf(centre), activeIndex = 1) }.isFailure)
        assertEquals(1, OverlayLayout(listOf(centre, right)).activated(7).activeIndex)
        assertEquals(0, OverlayLayout(listOf(centre, right)).activated(-3).activeIndex)
    }

    @Test
    fun `moving a free spot leaves the others alone`() {
        val moved = OverlayLayout.DEFAULT.moved(1, OverlayAnchor(0.8f, -18f))
        assertEquals(centre, moved.spots[0])
        assertEquals(OverlayAnchor(0.8f, -18f), moved.spots[1])
    }

    @Test
    fun `moved spots are rounded so a drag does not persist float noise`() {
        val moved = OverlayLayout.DEFAULT.moved(0, OverlayAnchor(0.123456f, -17.987f))
        assertEquals(OverlayAnchor(0.1235f, -17.99f), moved.spots[0])
    }

    @Test
    fun `under a row lock every spot follows the moved one vertically`() {
        val row = OverlayLayout(listOf(centre, right, OverlayAnchor(0.1f, 30f)), arrangement = OverlayArrangement.SAME_ROW)
        val moved = row.moved(1, OverlayAnchor(0.95f, -20f))
        assertEquals(OverlayAnchor(0.5f, -20f), moved.spots[0])
        assertEquals(OverlayAnchor(0.95f, -20f), moved.spots[1])
        assertEquals(OverlayAnchor(0.1f, -20f), moved.spots[2])
    }

    @Test
    fun `under a column lock every spot follows the moved one sideways`() {
        val column = OverlayLayout(listOf(centre, OverlayAnchor(0.5f, 90f)), arrangement = OverlayArrangement.SAME_COLUMN)
        val moved = column.moved(0, OverlayAnchor(0.2f, 40f))
        assertEquals(OverlayAnchor(0.2f, 40f), moved.spots[0])
        assertEquals(OverlayAnchor(0.2f, 90f), moved.spots[1])
    }

    @Test
    fun `switching on a lock lines the spots up with the active one`() {
        val scattered = OverlayLayout(listOf(OverlayAnchor(0.2f, 10f), OverlayAnchor(0.7f, 80f)), activeIndex = 1)
        val row = scattered.arranged(OverlayArrangement.SAME_ROW)
        assertEquals(listOf(OverlayAnchor(0.2f, 80f), OverlayAnchor(0.7f, 80f)), row.spots)
        val column = scattered.arranged(OverlayArrangement.SAME_COLUMN)
        assertEquals(listOf(OverlayAnchor(0.7f, 10f), OverlayAnchor(0.7f, 80f)), column.spots)
        // Going back to free changes nothing.
        assertEquals(row.spots, row.arranged(OverlayArrangement.FREE).spots)
        assertEquals(OverlayArrangement.FREE, row.arranged(OverlayArrangement.FREE).arrangement)
    }

    @Test
    fun `adding a spot mirrors the active one across the middle and selects it`() {
        val single = OverlayLayout(listOf(toolbar))
        val two = single.added()!!
        assertEquals(2, two.spots.size)
        assertEquals(1, two.activeIndex)
        assertEquals(OverlayAnchor(0.1f, -20f), two.active)
    }

    @Test
    fun `adding next to a centred spot goes to the edge instead of mirroring onto itself`() {
        val single = OverlayLayout(listOf(centre))
        assertEquals(right, single.added()!!.active)
        // From the default layout (centre + right edge) the next free place is the left edge.
        assertEquals(OverlayAnchor(0f, 30f), OverlayLayout.DEFAULT.added()!!.active)
    }

    @Test
    fun `added spots never land on top of an existing one`() {
        var layout = OverlayLayout(listOf(centre))
        while (layout.canAdd) layout = layout.added()!!
        assertEquals(OverlayLayout.MAX_SPOTS, layout.spots.size)
        for (i in layout.spots.indices) for (j in layout.spots.indices) {
            if (i != j) assertFalse("spots $i and $j overlap", layout.spots[i].overlaps(layout.spots[j]))
        }
        assertNull(layout.added())
    }

    @Test
    fun `under a column lock a new spot stacks above the active one`() {
        val column = OverlayLayout(listOf(OverlayAnchor(0.9f, 30f)), arrangement = OverlayArrangement.SAME_COLUMN)
        val added = column.added()!!
        assertEquals(OverlayAnchor(0.9f, 78f), added.active)
        assertEquals(OverlayAnchor(0.9f, 30f), added.spots[0])
    }

    @Test
    fun `removing a spot keeps the selection sensible and never empties the layout`() {
        val three = OverlayLayout(listOf(centre, right, toolbar), activeIndex = 2)
        val removedActive = three.removed(2)!!
        assertEquals(listOf(centre, right), removedActive.spots)
        assertEquals(1, removedActive.activeIndex)
        val removedBefore = three.removed(0)!!
        assertEquals(listOf(right, toolbar), removedBefore.spots)
        assertEquals(1, removedBefore.activeIndex)
        val removedAfter = OverlayLayout(listOf(centre, right, toolbar), activeIndex = 0).removed(2)!!
        assertEquals(0, removedAfter.activeIndex)
        assertNull(OverlayLayout(listOf(centre)).removed(0))
        assertNull(three.removed(9))
    }

    @Test
    fun `the codec round-trips every field`() {
        val layout = OverlayLayout(listOf(centre, toolbar, OverlayAnchor(0.1234f, 77.5f)), activeIndex = 1, arrangement = OverlayArrangement.SAME_ROW)
        val encoded = OverlayLayoutCodec.encode(layout)
        assertEquals(layout, OverlayLayoutCodec.decode(encoded))
        assertNotEquals(OverlayLayoutCodec.encode(OverlayLayout.DEFAULT), encoded)
    }

    @Test
    fun `the codec shrugs off garbage and clamps what it can`() {
        assertNull(OverlayLayoutCodec.decode(null))
        assertNull(OverlayLayoutCodec.decode(""))
        assertNull(OverlayLayoutCodec.decode("not json"))
        assertNull(OverlayLayoutCodec.decode("""{"spots":[],"active":0}"""))
        val clamped = OverlayLayoutCodec.decode("""{"spots":[{"x":1.7,"y":30},{"x":-2,"y":5}],"active":9,"arrangement":"diagonal","extra":true}""")!!
        assertEquals(listOf(OverlayAnchor(1f, 30f), OverlayAnchor(0f, 5f)), clamped.spots)
        assertEquals(1, clamped.activeIndex)
        assertEquals(OverlayArrangement.FREE, clamped.arrangement)
        val tooMany = OverlayLayoutCodec.decode("""{"spots":[{"x":0.1,"y":0},{"x":0.2,"y":0},{"x":0.3,"y":0},{"x":0.4,"y":0},{"x":0.5,"y":0}]}""")!!
        assertEquals(OverlayLayout.MAX_SPOTS, tooMany.spots.size)
    }

    @Test
    fun `a single legacy position becomes the active spot with a companion`() {
        val legacy = OverlayLayout.fromLegacy(toolbar)
        assertEquals(2, legacy.spots.size)
        assertEquals(0, legacy.activeIndex)
        assertEquals(toolbar, legacy.active)
        assertEquals(OverlayAnchor(0.1f, -20f), legacy.spots[1])
    }

    @Test
    fun `positions read naturally`() {
        assertEquals("Centred, 30 dp above the keyboard", centre.describe())
        assertEquals("Right edge, 30 dp above the keyboard", right.describe())
        assertEquals("10% from the right, 20 dp down over the keyboard", toolbar.describe())
        assertEquals("Left edge, on the keyboard's top edge", OverlayAnchor(0f, 0f).describe())
        assertEquals("25% from the left · 12 dp over", OverlayAnchor(0.25f, -12f).describe(short = true))
        assertEquals("Centred · 30 dp above", centre.describe(short = true))
    }
}
