package app.murmur.android

import androidx.activity.BackEventCompat
import app.murmur.android.ui.CornerRampEnd
import app.murmur.android.ui.CoverFadeEnd
import app.murmur.android.ui.UnderParallax
import app.murmur.android.ui.directionFor
import app.murmur.android.ui.revealFraction
import app.murmur.android.ui.topMotion
import app.murmur.android.ui.underMotion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The progress mapping of the predictive back transition (ui/BackStackHost.kt, ported from Cursor
 * for Android): the leaving screen slides the way the finger moves and never shrinks, the screen
 * underneath fades in behind it with a short drift, and a lateral move is a plain crossfade.
 */
class BackStackMotionTest {

    private val width = 1080f
    private val corner = 66f

    @Test
    fun `at rest nothing has moved, faded or rounded`() {
        val top = topMotion(0f, 1f, width, corner, crossfade = false)
        assertEquals(0f, top.translationX, 0f)
        assertEquals(1f, top.alpha, 0f)
        assertEquals(0f, top.cornerRadius, 0f)
        val under = underMotion(0f, 1f, width, crossfade = false)
        assertEquals(0f, under.alpha, 0f)
        assertEquals(-width * UnderParallax, under.translationX, 1e-3f)
    }

    @Test
    fun `the leaving screen slides by exactly the gesture's progress, full size and opaque`() {
        for (p in listOf(0.1f, 0.25f, 0.5f, 0.75f, 1f)) {
            val m = topMotion(p, 1f, width, corner, crossfade = false)
            assertEquals("progress $p", p * width, m.translationX, 1e-3f)
            assertEquals(1f, m.alpha, 0f)
        }
    }

    @Test
    fun `a left-edge swipe sends it right, a right-edge swipe sends it left`() {
        assertEquals(1f, directionFor(BackEventCompat.EDGE_LEFT), 0f)
        assertEquals(-1f, directionFor(BackEventCompat.EDGE_RIGHT), 0f)
        val right = topMotion(0.5f, directionFor(BackEventCompat.EDGE_LEFT), width, corner, crossfade = false)
        val left = topMotion(0.5f, directionFor(BackEventCompat.EDGE_RIGHT), width, corner, crossfade = false)
        assertEquals(-right.translationX, left.translationX, 1e-3f)
        assertTrue(right.translationX > 0f)
    }

    @Test
    fun `the corners round over the first quarter and stay round`() {
        assertEquals(corner / 2, topMotion(CornerRampEnd / 2, 1f, width, corner, false).cornerRadius, 1e-3f)
        assertEquals(corner, topMotion(CornerRampEnd, 1f, width, corner, false).cornerRadius, 1e-3f)
        assertEquals(corner, topMotion(0.9f, 1f, width, corner, false).cornerRadius, 1e-3f)
    }

    @Test
    fun `the screen underneath fades in smoothly and drifts into place from a quarter width off`() {
        assertEquals(0f, revealFraction(0f), 0f)
        assertEquals(0.5f, revealFraction(0.5f), 1e-6f)
        assertEquals(1f, revealFraction(1f), 0f)
        // Slow to start: a quarter of the way in, well under a quarter revealed.
        assertTrue(revealFraction(0.25f) < 0.2f)
        var last = -1f
        for (i in 0..20) {
            val f = revealFraction(i / 20f)
            assertTrue("monotonic at $i", f >= last)
            last = f
        }
        val half = underMotion(0.5f, 1f, width, crossfade = false)
        assertEquals(revealFraction(0.5f), half.alpha, 1e-6f)
        assertEquals(-0.5f * width * UnderParallax, half.translationX, 1e-3f)
        val done = underMotion(1f, 1f, width, crossfade = false)
        assertEquals(1f, done.alpha, 0f)
        assertEquals(0f, done.translationX, 0f)
        assertEquals(0f, done.cornerRadius, 0f)
    }

    @Test
    fun `the drift follows the direction the top screen leaves in`() {
        assertTrue(underMotion(0.5f, 1f, width, false).translationX < 0f)
        assertTrue(underMotion(0.5f, -1f, width, false).translationX > 0f)
    }

    @Test
    fun `a lateral move crossfades without moving either screen`() {
        for (p in listOf(0.2f, 0.5f, 0.8f)) {
            val top = topMotion(p, 1f, width, corner, crossfade = true)
            assertEquals(0f, top.translationX, 0f)
            assertEquals(0f, top.cornerRadius, 0f)
            assertEquals(1f - p, top.alpha, 1e-6f)
            assertEquals(0f, underMotion(p, 1f, width, crossfade = true).translationX, 0f)
        }
        // The covered screen is gone by the midpoint of the fade, so the two are never both legible.
        assertEquals(1f, underMotion(1f, 1f, width, crossfade = true).alpha, 0f)
        assertEquals(0f, underMotion(CoverFadeEnd, 1f, width, crossfade = true).alpha, 0f)
        assertEquals(0f, underMotion(0.2f, 1f, width, crossfade = true).alpha, 0f)
        assertEquals(0.5f, underMotion(0.75f, 1f, width, crossfade = true).alpha, 1e-6f)
    }

    @Test
    fun `progress outside the range is clamped`() {
        assertEquals(width, topMotion(1.5f, 1f, width, corner, false).translationX, 1e-3f)
        assertEquals(0f, topMotion(-0.5f, 1f, width, corner, false).translationX, 0f)
        assertEquals(1f, underMotion(2f, 1f, width, false).alpha, 0f)
    }
}
