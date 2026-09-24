package app.murmur.android

import app.murmur.android.dictation.Cue
import app.murmur.android.dictation.Cues
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The synthesized cues: every moment has one, each is a short burst that starts from silence and
 * fades to silence, its loudness follows the volume setting, and zero volume renders nothing.
 */
class CuesTest {
    @Test
    fun `every cue is a short burst that fades to silence`() {
        for (cue in Cue.entries) {
            val pcm = Cues.pcm(cue, 0.35f)!!
            val ms = pcm.size * 1000 / Cues.SAMPLE_RATE
            assertTrue("$cue lasts $ms ms", ms in 100..400)
            assertTrue("$cue starts from silence", pcm.take(20).all { kotlin.math.abs(it.toInt()) < 400 })
            assertTrue("$cue ends in silence", pcm.takeLast(200).all { kotlin.math.abs(it.toInt()) < 400 })
            val peak = Cues.peak(pcm)
            assertTrue("$cue peaks at $peak", peak > 0.08 && peak <= 0.35)
        }
    }

    @Test
    fun `the volume setting scales the cue and zero renders nothing`() {
        val quiet = Cues.peak(Cues.pcm(Cue.START, 0.2f)!!)
        val loud = Cues.peak(Cues.pcm(Cue.START, 1f)!!)
        assertTrue("$quiet < $loud", quiet < loud)
        assertEquals(loud / quiet, 5.0, 0.1)
        assertNull(Cues.pcm(Cue.STOP, 0f))
        assertNull(Cues.pcm(Cue.STOP, -1f))
    }

    @Test
    fun `the cues differ from one another`() {
        val lengths = Cue.entries.associateWith { Cues.pcm(it, 0.5f)!!.size }
        assertTrue(lengths[Cue.ERROR]!! > lengths[Cue.START]!!)
        assertTrue(lengths[Cue.LOCK]!! > lengths[Cue.CANCEL]!!)
    }
}
