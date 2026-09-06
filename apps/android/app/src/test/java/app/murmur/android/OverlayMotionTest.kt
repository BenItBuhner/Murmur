package app.murmur.android

import app.murmur.android.overlay.Box
import app.murmur.android.overlay.LayerStack
import app.murmur.android.overlay.OverlayMotion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Content cross-fade timing for the floating pill (see OverlayMotion / LayerStack). */
class OverlayMotionTest {
    private val box = Box(0f, 0f, 100f, 40f)
    private val wide = Box(0f, 0f, 400f, 46f)

    private fun <T> LayerStack<T>.alpha(content: T, now: Long): Float? =
        layers.firstOrNull { it.content == content }?.let { alphaOf(it, now) }

    @Test
    fun `a hand-over is complementary so the pill is never empty`() {
        for (ms in 0L..OverlayMotion.FADE_MS step 5L) {
            val sum = OverlayMotion.fadeIn(0f, ms) + OverlayMotion.fadeOut(1f, ms)
            assertEquals("t=$ms", 1f, sum, 1e-4f)
        }
        // Half-way through, both contents are equally present.
        assertEquals(0.5f, OverlayMotion.fadeIn(0f, OverlayMotion.FADE_MS / 2), 1e-4f)
        // Before the start / after the end the alphas are clamped.
        assertEquals(0f, OverlayMotion.fadeIn(0f, -20L), 0f)
        assertEquals(1f, OverlayMotion.fadeIn(0f, OverlayMotion.FADE_MS + 500L), 0f)
        assertEquals(0f, OverlayMotion.fadeOut(1f, OverlayMotion.FADE_MS), 0f)
    }

    @Test
    fun `contents are half-way in by the time the outline is two thirds of the way`() {
        // The outline morph runs 340 ms. The old schedule only reached 50 % contents at 225 ms,
        // when the outline had all but settled; now it happens while the outline is still moving.
        val halfIn = OverlayMotion.FADE_MS / 2
        assertEquals(0.5f, OverlayMotion.fadeIn(0f, halfIn), 1e-4f)
        val outlineProgress = OverlayMotion.easeOutCubic(halfIn.toFloat() / OverlayMotion.MORPH_MS)
        assertTrue("outline progress $outlineProgress", outlineProgress in 0.6f..0.8f)
        assertTrue(OverlayMotion.FADE_MS < OverlayMotion.MORPH_MS)
    }

    @Test
    fun `push fades the previous layer out from where it is and the new one in from zero`() {
        val stack = LayerStack<String>()
        stack.snap("idle", box, 1_000L)
        stack.push("listening", wide, 1_000L)
        assertEquals("listening", stack.current?.content)
        assertEquals(1f, stack.alpha("idle", 1_000L)!!, 0f)
        assertEquals(0f, stack.alpha("listening", 1_000L)!!, 0f)

        val mid = 1_000L + OverlayMotion.FADE_MS / 2
        assertEquals(0.5f, stack.alpha("idle", mid)!!, 1e-4f)
        assertEquals(0.5f, stack.alpha("listening", mid)!!, 1e-4f)
        assertFalse(stack.isSettled(mid))

        val done = 1_000L + OverlayMotion.FADE_MS
        stack.prune(done)
        assertNull(stack.alpha("idle", done))
        assertEquals(1f, stack.alpha("listening", done)!!, 0f)
        assertTrue(stack.isSettled(done))
    }

    @Test
    fun `a state change landing one frame into a fade keeps what is visible`() {
        // Regression: "Formatting…" -> "Inserted" arriving 8 ms after another retarget used to make
        // the visible label vanish in a single frame and leave the pill blank for ~230 ms.
        val stack = LayerStack<String>()
        stack.snap("formatting", wide, 0L)
        stack.push("other", wide, 10_000L)
        stack.push("inserted", box, 10_008L)

        assertEquals("inserted", stack.current?.content)
        val formatting = stack.alpha("formatting", 10_008L)
        assertNotNull("the layer that was on screen must still be in the stack", formatting)
        assertTrue("still essentially fully visible one frame later: $formatting", formatting!! > 0.98f)

        // It then fades out on its own schedule while the new contents fade in; the combined
        // presence never drops below one half.
        for (ms in 0L..OverlayMotion.FADE_MS step 4L) {
            val now = 10_008L + ms
            val total = stack.layers.sumOf { stack.alphaOf(it, now).toDouble() }
            assertTrue("t=$ms presence=$total", total >= 0.5 - 1e-3)
        }
        // The intermediate layer never became visible, so it is dropped rather than drawn.
        assertNull(stack.alpha("other", 10_008L))
    }

    @Test
    fun `pushing contents that are still fading out promotes them instead of restarting`() {
        val stack = LayerStack<String>()
        stack.snap("a", box, 0L)
        stack.push("b", wide, 0L)
        val back = OverlayMotion.FADE_MS / 4
        val aBefore = stack.alpha("a", back)!!
        val bBefore = stack.alpha("b", back)!!
        stack.push("a", box, back)

        assertEquals("a", stack.current?.content)
        assertEquals(2, stack.layers.size)
        assertEquals(aBefore, stack.alpha("a", back)!!, 1e-5f)
        assertEquals(bBefore, stack.alpha("b", back)!!, 1e-5f)
        assertTrue(stack.layers.first { it.content == "b" }.leaving)
        // "a" resumes towards full alpha from where it was, not from zero.
        assertTrue(stack.alpha("a", back + 40L)!! > aBefore)
    }

    @Test
    fun `pushing the current contents again is a no-op`() {
        val stack = LayerStack<String>()
        stack.snap("a", box, 0L)
        val layer = stack.current
        stack.push("a", box, 50L)
        assertSame(layer, stack.current)
        assertEquals(1, stack.layers.size)
    }

    @Test
    fun `snap replaces everything at full alpha`() {
        val stack = LayerStack<String>()
        stack.snap("a", box, 0L)
        stack.push("b", wide, 0L)
        stack.snap("c", box, 10L)
        assertEquals(1, stack.layers.size)
        assertEquals(1f, stack.alpha("c", 10L)!!, 0f)
        assertTrue(stack.isSettled(10L))
    }

    @Test
    fun `never more than three leaving layers, and the faintest are shed first`() {
        val stack = LayerStack<String>()
        stack.snap("0", box, 0L)
        // A burst of six states 20 ms apart: each intermediate one barely became visible.
        for (i in 1..6) stack.push("$i", box, i * 20L)
        assertEquals("6", stack.current?.content)
        assertTrue(stack.layers.count { it.leaving } <= 3)
        // What was actually on screen ("0", still over half opaque) survives the cap; the
        // near-invisible intermediates are the ones dropped.
        val zero = stack.alpha("0", 120L)
        assertNotNull(zero)
        assertTrue("$zero", zero!! > 0.5f)
        assertNull(stack.alpha("1", 120L))
        assertNull(stack.alpha("2", 120L))
    }

    @Test
    fun `new layers rest where they will land`() {
        val stack = LayerStack<String>()
        stack.snap("a", box, 0L)
        stack.push("b", wide, 0L)
        val b = stack.current!!
        assertEquals(wide, b.box)
        assertEquals(wide, b.fromBox)
        assertEquals(0L, b.shownSince)
    }

    @Test
    fun `box scaling is about the given point`() {
        val b = Box(10f, 10f, 30f, 20f)
        val s = b.scaled(0.5f, 10f, 10f)
        assertEquals(Box(10f, 10f, 20f, 15f), s)
        val c = b.scaled(2f, b.centerX, b.centerY)
        assertEquals(Box(0f, 5f, 40f, 25f), c)
        assertEquals(b, b.scaled(1f, 0f, 0f))
    }

    @Test
    fun `box interpolation`() {
        val a = Box(0f, 0f, 10f, 10f)
        val b = Box(10f, 20f, 30f, 50f)
        assertEquals(a, OverlayMotion.lerp(a, b, 0f))
        assertEquals(b, OverlayMotion.lerp(a, b, 1f))
        assertEquals(Box(5f, 10f, 20f, 30f), OverlayMotion.lerp(a, b, 0.5f))
    }
}
