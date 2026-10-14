package app.murmur.android

import app.murmur.android.audio.Wav
import app.murmur.android.text.Hallucination
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HallucinationTest {
    @Test
    fun knowsStockPhrasesAndNothingLonger() {
        assertTrue(Hallucination.isSilencePhrase(" Thank you."))
        assertTrue(Hallucination.isSilencePhrase("Thank you. Thank you."))
        assertTrue(Hallucination.isSilencePhrase("Thanks for watching!"))
        assertFalse(Hallucination.isSilencePhrase("Thank you for the report."))
    }

    @Test
    fun countsVoicedTime() {
        val rate = 16_000
        val silence = ShortArray(rate)
        assertEquals(0, Wav.voicedMs(silence, rate))
        val tone = ShortArray(rate) { i -> (8000 * Math.sin(i * 2 * Math.PI * 220 / rate)).toInt().toShort() }
        assertEquals(1000, Wav.voicedMs(tone, rate))
    }
}
