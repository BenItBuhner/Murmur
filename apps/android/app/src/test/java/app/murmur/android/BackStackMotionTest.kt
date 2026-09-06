package app.murmur.android

import app.murmur.android.ui.BackGesture
import app.murmur.android.ui.surfaceMotion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The predictive-back lift-off of a full-screen surface (ui/BackStackHost.kt), checked against the
 * numbers Material's back helper and the system's cross-activity animation use.
 */
class BackStackMotionTest {

    private val width = 1080f
    private val height = 2400f
    private val gap = 24f
    private val maxDy = 300f
    private val radius = 66f

    private fun motion(lift: Float, gesture: BackGesture?) =
        surfaceMotion(lift, gesture, width, height, gap, maxTranslationY = maxDy, cornerRadius = radius)

    private fun left(progress: Float, dy: Float = 0f) = BackGesture(progress, fromLeft = true, dy = dy)
    private fun right(progress: Float, dy: Float = 0f) = BackGesture(progress, fromLeft = false, dy = dy)

    @Test
    fun `nothing moves before the gesture has made progress`() {
        for (m in listOf(motion(0f, null), motion(0f, left(0f)), motion(0f, right(0f, dy = 400f)))) {
            assertEquals(1f, m.scale, 0f)
            assertEquals(0f, m.translationX, 0f)
            assertEquals(0f, m.translationY, 0f)
            assertEquals(0f, m.cornerRadius, 0f)
        }
    }

    @Test
    fun `a back press shrinks the surface in place to 90 percent with rounded corners`() {
        val m = motion(1f, gesture = null)
        assertEquals(0.9f, m.scale, 1e-6f)
        assertEquals(0f, m.translationX, 0f)
        assertEquals(0f, m.translationY, 0f)
        assertEquals(radius, m.cornerRadius, 1e-6f)
    }

    @Test
    fun `halfway there the surface is halfway shrunk and halfway rounded`() {
        val m = motion(0.5f, gesture = null)
        assertEquals(0.95f, m.scale, 1e-6f)
        assertEquals(radius / 2, m.cornerRadius, 1e-6f)
    }

    @Test
    fun `a swipe from the left pushes the surface right until it rests a gap from the right edge`() {
        val m = motion(1f, left(1f))
        assertTrue(m.translationX > 0f)
        val rightEdge = width / 2 + m.translationX + width * m.scale / 2
        assertEquals(width - gap, rightEdge, 1e-3f)
    }

    @Test
    fun `a swipe from the right mirrors the push`() {
        assertEquals(-motion(1f, left(1f)).translationX, motion(1f, right(1f)).translationX, 1e-6f)
        val m = motion(1f, right(1f))
        val leftEdge = width / 2 + m.translationX - width * m.scale / 2
        assertEquals(gap, leftEdge, 1e-3f)
    }

    @Test
    fun `the push grows with the lift`() {
        val quarter = motion(0.25f, left(0.25f)).translationX
        val half = motion(0.5f, left(0.5f)).translationX
        val full = motion(1f, left(1f)).translationX
        assertTrue(0f < quarter && quarter < half && half < full)
        assertEquals(full / 2, half, 1e-3f)
    }

    @Test
    fun `the surface follows the finger up and down, no further than the room it has`() {
        // The freed vertical space minus the gap (96 px here) binds before the 300 px cap does.
        val headroom = minOf((height - height * 0.9f) / 2 - gap, maxDy)
        assertEquals(96f, headroom, 1e-3f)

        val down = motion(1f, left(1f, dy = height / 4))
        val up = motion(1f, left(1f, dy = -height / 4))
        assertTrue(down.translationY > 0f)
        assertEquals(-down.translationY, up.translationY, 1e-6f)
        assertEquals(headroom / 4, down.translationY, 1e-3f)

        val farther = motion(1f, left(1f, dy = height / 2))
        assertTrue(farther.translationY > down.translationY)
        val wayOff = motion(1f, left(1f, dy = height * 3))
        assertEquals(headroom, wayOff.translationY, 1e-3f)
    }

    @Test
    fun `on a tall surface the cap is what limits the follow`() {
        val tall = surfaceMotion(1f, left(1f, dy = 100_000f), width, height = 20_000f, edgeGap = gap, maxTranslationY = maxDy, cornerRadius = radius)
        assertEquals(maxDy, tall.translationY, 1e-3f)
    }

    @Test
    fun `the vertical follow never leaves less than the gap above or below`() {
        // Little headroom: a short surface cannot move the whole cap.
        val short = surfaceMotion(1f, left(1f, dy = 10_000f), width, height = 1000f, edgeGap = gap, maxTranslationY = maxDy, cornerRadius = radius)
        val headroom = (1000f - 1000f * short.scale) / 2 - gap
        assertTrue(headroom > 0f && headroom < maxDy)
        assertEquals(headroom, short.translationY, 1e-3f)
    }

    @Test
    fun `a gap wider than the room to move means no push rather than a pull the other way`() {
        val m = surfaceMotion(1f, left(1f), width = 100f, height = 100f, edgeGap = 40f, maxTranslationY = maxDy, cornerRadius = radius)
        assertEquals(0f, m.translationX, 0f)
        assertEquals(0f, m.translationY, 0f)
    }

    @Test
    fun `an unmeasured surface produces finite values`() {
        val m = surfaceMotion(0.7f, left(0.7f, dy = 50f), width = 0f, height = 0f, edgeGap = gap, maxTranslationY = maxDy, cornerRadius = radius)
        assertTrue(m.scale.isFinite() && m.translationX.isFinite() && m.translationY.isFinite() && m.cornerRadius.isFinite())
        assertEquals(0f, m.translationX, 0f)
        assertEquals(0f, m.translationY, 0f)
    }
}
