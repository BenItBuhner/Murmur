package app.murmur.android

import app.murmur.android.audio.Wav
import app.murmur.android.dictation.dropUnspokenEnding
import app.murmur.android.stt.TimedWord
import app.murmur.android.stt.wordsFromVerbose
import app.murmur.android.text.Hallucination
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

/** A stock phrase at the end of real speech goes only when no voice sits under it (desktop parity). */
class UnspokenEndingTest {
    private val rate = 16_000

    /** 2 s of a 160 Hz voice-like tone, then 1.5 s that is either more tone or a noise rustle. */
    private fun clip(voicedEnd: Boolean): ShortArray {
        var seed = 7L
        fun noise(): Double {
            seed = (seed * 1103515245 + 12345) and 0x7fffffff
            return seed / 0x7fffffff.toDouble() - 0.5
        }
        return ShortArray((3.5 * rate).toInt()) { i ->
            val t = i.toDouble() / rate
            val v = if (t < 2.0 || voicedEnd) sin(2 * PI * 160 * t) * 8000 else noise() * 6000
            v.toInt().toShort()
        }
    }

    private val words = listOf(
        TimedWord(" a", 0.1, 0.4), TimedWord(" really", 0.5, 0.9), TimedWord(" solid", 1.0, 1.4),
        TimedWord(" week", 1.5, 1.9), TimedWord(" you", 2.6, 2.9)
    )

    @Test
    fun `a phrase on noise is dropped`() {
        assertEquals("A really solid week", dropUnspokenEnding("A really solid week you", words, clip(false), rate))
    }

    @Test
    fun `a phrase on a voice stays`() {
        assertEquals("A really solid week you", dropUnspokenEnding("A really solid week you", words, clip(true), rate))
    }

    @Test
    fun `no timings, an edited text or a whole-phrase transcript stay`() {
        assertEquals("A really solid week you", dropUnspokenEnding("A really solid week you", null, clip(false), rate))
        // The text no longer ends with the timed words (a gateway already edited it).
        assertEquals("A really solid week.", dropUnspokenEnding("A really solid week.", words, clip(false), rate))
        val only = listOf(TimedWord("Thank", 2.2, 2.5), TimedWord("you.", 2.5, 2.9))
        assertEquals("Thank you.", dropUnspokenEnding("Thank you.", only, clip(false), rate))
    }

    @Test
    fun `pitch tells a voice from noise`() {
        assertTrue(Wav.pitchedMs(clip(true), rate, 2.0, 3.5) > 1000)
        assertTrue(Wav.pitchedMs(clip(false), rate, 2.0, 3.5) < Hallucination.STOCK_PHRASE_MIN_PITCHED_MS)
    }

    @Test
    fun `verbose words parse, and a word without text means no words`() {
        val ok = JSONObject("""{"words":[{"word":"hi","start":0.0,"end":0.3},{"word":"you","start":0.5,"end":0.7}]}""")
        assertEquals(listOf(TimedWord("hi", 0.0, 0.3), TimedWord("you", 0.5, 0.7)), wordsFromVerbose(ok))
        assertNull(wordsFromVerbose(JSONObject("""{"words":[{"start":0.0,"end":0.3}]}""")))
        assertNull(wordsFromVerbose(JSONObject("""{"segments":[{"start":0,"end":1}]}""")))
    }

    @Test
    fun `last words drop with their punctuation`() {
        assertEquals("Send it to me.", Hallucination.dropLastWords("Send it to me. Thank you.", 2))
        assertEquals(2, Hallucination.trailingStockPhraseCount(listOf("send", "it", "Thank", "you.")))
        assertEquals(0, Hallucination.trailingStockPhraseCount(listOf("send", "it", "now")))
    }
}
