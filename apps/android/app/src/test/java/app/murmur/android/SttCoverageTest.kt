package app.murmur.android

import app.murmur.android.audio.Wav
import app.murmur.android.stt.TimedSpan
import app.murmur.android.stt.TranscribeOutput
import app.murmur.android.stt.adaptiveThreshold
import app.murmur.android.stt.assessCoverage
import app.murmur.android.stt.findCutPoint
import app.murmur.android.stt.lastVoicedSec
import app.murmur.android.stt.mergeTranscripts
import app.murmur.android.stt.spansFromVerbose
import app.murmur.android.stt.transcribeComplete
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors apps/desktop/tests/stt-coverage.test.ts. */
class SttCoverageTest {
    private val rate = 16_000
    private val threshold = -48.0

    /** Deterministic noise bursts (speech) and near-silence (pauses) at the given times. */
    private fun clip(totalSec: Double, speech: List<Pair<Double, Double>>): ShortArray {
        val pcm = ShortArray((totalSec * rate).toInt())
        var seed = 12345L
        fun rnd(): Double {
            seed = (seed * 1103515245L + 12345L) and 0x7fffffffL
            return seed / 0x7fffffff.toDouble() - 0.5
        }
        for (i in pcm.indices) pcm[i] = (rnd() * 20).toInt().toShort()
        for ((from, to) in speech) {
            for (i in (from * rate).toInt() until minOf(pcm.size, (to * rate).toInt())) pcm[i] = (rnd() * 16000).toInt().toShort()
        }
        return pcm
    }

    private fun out(text: String, lastEnd: Double? = null) =
        TranscribeOutput(text = text, latencyMs = 10, spans = lastEnd?.let { listOf(TimedSpan(0.0, it)) })

    private fun wavSeconds(wav: ByteArray): Double = Wav.decodePcm16(wav).first.size / rate.toDouble()

    private val head = "This is an Android app. Please implement this in a clean manner and Wispr Flow."
    private val tail = "It should also keep the pill visible while the keyboard is up."
    private val pcm = clip(20.0, listOf(0.3 to 8.0, 8.6 to 19.7))
    private val speechEnd = lastVoicedSec(pcm, rate, threshold)

    @Test
    fun `coverage from timings, word rate and empty answers`() {
        assertFalse(assessCoverage(out("hello there how are you", 19.6), 20.0).truncated)
        val cut = assessCoverage(out("please implement this and Wispr Flow", 7.9), 60.0)
        assertTrue(cut.truncated)
        assertEquals("timestamps", cut.reason)
        assertEquals(52.1, cut.missingSec, 0.05)
        assertFalse(assessCoverage(out("a few words here", 8.2), 10.0).truncated)
        val sparse = assessCoverage(out("only eleven words came back for a very long recording here"), 60.0)
        assertTrue(sparse.truncated)
        assertEquals("rate", sparse.reason)
        assertNull(sparse.transcribedSec)
        assertFalse(assessCoverage(out((1..40).joinToString(" ") { "word" }), 20.0).truncated)
        assertFalse(assessCoverage(out("send it"), 5.0).truncated)
        val empty = assessCoverage(out(""), 12.0)
        assertTrue(empty.truncated)
        assertEquals("empty", empty.reason)
        assertEquals(0.0, empty.transcribedSec)
        assertFalse(assessCoverage(out(""), 1.5).truncated)
    }

    @Test
    fun `voice activity helpers find the end of speech and a threshold above the noise floor`() {
        assertEquals(19.7, speechEnd, 0.05)
        assertTrue(adaptiveThreshold(pcm, rate, -48.0) >= -48.0)
        assertEquals(-1.0, lastVoicedSec(ShortArray(rate), rate, threshold), 0.0)
    }

    @Test
    fun `cut point sits in the pause after the point where the transcript stopped`() {
        val cut = findCutPoint(pcm, rate, 7.9, threshold)
        assertTrue("cut $cut", cut > 8.05 && cut < 8.55)
        assertEquals(13.9, findCutPoint(pcm, rate, 14.0, threshold), 0.01)
    }

    @Test
    fun `merge drops the words the tail repeats from the seam but not one short shared word`() {
        assertEquals(
            "Please implement this in a clean manner and Wispr Flow. It should also use the predictive back gesture.",
            mergeTranscripts(
                "Please implement this in a clean manner and Wispr Flow.",
                "Wispr Flow. It should also use the predictive back gesture."
            )
        )
        assertEquals("send it to the the report today", mergeTranscripts("send it to the", "the report today"))
        assertEquals("we talked about kubernetes is hard", mergeTranscripts("we talked about kubernetes", "kubernetes is hard"))
        assertEquals("tail", mergeTranscripts("", "tail"))
        assertEquals("head", mergeTranscripts("head", "  "))
    }

    @Test
    fun `spans prefer word timings over segment timings`() {
        val json = JSONObject(
            """{"text":"x","segments":[{"start":0,"end":30,"no_speech_prob":0.1}],"words":[{"word":"x","start":0.5,"end":7.9}]}"""
        )
        assertEquals(listOf(TimedSpan(0.5, 7.9)), spansFromVerbose(json))
        assertEquals(listOf(TimedSpan(0.0, 30.0)), spansFromVerbose(JSONObject("""{"segments":[{"start":0,"end":30}]}""")))
        assertNull(spansFromVerbose(JSONObject("""{"segments":[{"no_speech_prob":0.1}]}""")))
    }

    @Test
    fun `resumes from the pause after the point where the prompted transcript stopped`() = runBlocking {
        val calls = ArrayList<Pair<Double, String?>>()
        val r = transcribeComplete(
            pcm, rate, speechEnd, threshold,
            prompt = "Vocabulary: Wispr Flow. Dictation with punctuation.",
            tailPrompt = "Dictation with punctuation."
        ) { wav, prompt ->
            val seconds = wavSeconds(wav)
            calls.add(seconds to prompt)
            // The vocabulary prompt makes the model stop right after "Wispr Flow".
            if (prompt?.contains("Vocabulary") == true) out(head, 7.9) else out(tail, seconds - 0.2)
        }
        assertEquals("$head $tail", r.output.text)
        assertEquals(1, r.resumed)
        assertTrue(r.recoveredSec > 10)
        assertFalse(r.coverage.truncated)
        assertEquals(2, calls.size)
        assertEquals("Dictation with punctuation.", calls[1].second)
        // The tail starts inside the 8.0-8.6 s pause, so no word is cut in half.
        val cut = 20 - calls[1].first
        assertTrue("cut $cut", cut > 8.0 && cut < 8.6)
    }

    @Test
    fun `makes no extra request when the transcript covers the speech`() = runBlocking {
        var calls = 0
        val r = transcribeComplete(pcm, rate, speechEnd, threshold, prompt = "p", tailPrompt = null) { _, _ ->
            calls++
            out(head, 19.6)
        }
        assertEquals(1, calls)
        assertEquals(0, r.resumed)
        assertEquals(head, r.output.text)
    }

    @Test
    fun `retries the whole clip without the prompt when there are no timings to resume from`() = runBlocking {
        val prompts = ArrayList<String?>()
        val r = transcribeComplete(pcm, rate, speechEnd, threshold, prompt = "Vocabulary: x. Dictation.", tailPrompt = null) { _, prompt ->
            prompts.add(prompt)
            if (prompt != null) out("only a few words came back") else out("$head $tail")
        }
        assertEquals(listOf("Vocabulary: x. Dictation.", null), prompts)
        assertEquals("$head $tail", r.output.text)
        assertEquals(1, r.resumed)
        // ...but a retry that is not clearly fuller loses to the first answer.
        val same = transcribeComplete(pcm, rate, speechEnd, threshold, prompt = "p", tailPrompt = null) { _, prompt ->
            if (prompt != null) out("one two three four five") else out("one two three four six")
        }
        assertEquals("one two three four five", same.output.text)
        assertEquals(0, same.resumed)
    }

    @Test
    fun `never loses the head when the resume request fails`() = runBlocking {
        var calls = 0
        val r = transcribeComplete(pcm, rate, speechEnd, threshold, prompt = "p", tailPrompt = null) { _, _ ->
            calls++
            if (calls == 1) out(head, 7.9) else throw IllegalStateException("rate limited")
        }
        assertEquals(head, r.output.text)
        assertEquals(0, r.resumed)
        assertTrue(r.coverage.truncated)
    }

    @Test
    fun `chains several resumes when the recognizer keeps stopping early`() = runBlocking {
        val pieces = listOf("first part.", "second part.", "third part.")
        var calls = 0
        val r = transcribeComplete(pcm, rate, speechEnd, threshold, prompt = null, tailPrompt = null, maxRounds = 3) { wav, _ ->
            val seconds = wavSeconds(wav)
            val i = calls++
            // Each answer covers only the first half of whatever audio it was given.
            out(pieces.getOrElse(i) { "more." }, if (i == 0) 6.5 else minOf(seconds - 0.2, seconds / 2))
        }
        assertTrue("calls $calls", calls in 3..4)
        assertTrue(r.output.text.startsWith("first part. second part. third part."))
        assertTrue(r.resumed >= 2)
    }
}
