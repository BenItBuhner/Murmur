package app.murmur.android

import app.murmur.android.dictation.StopPhrase
import app.murmur.android.dictation.StopPhraseWatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sin

/** The spoken stop phrase: how it is matched at the end of a transcript, and when it is listened for. */
class StopPhraseTest {
    private val phrase = StopPhrase.DEFAULT

    @Test
    fun `the phrase matches at the end however the speech model writes it`() {
        for (text in listOf(
            "Can you take a look? Okay, send this now.",
            "can you take a look okay send this now",
            "Can you take a look? OK, send this now!",
            "Can you take a look? O.K. Send this now.",
            "Can you take a look? Okay. Send this now",
            "Can you take a look? Okay, send these now."
        )) assertTrue(text, StopPhrase.endsWith(text, phrase))
    }

    @Test
    fun `the phrase anywhere but the end, or something like it, does not match`() {
        for (text in listOf(
            "Okay, send this now, is what she told me. But the draft needs another pass.",
            "Okay, send this now and then call Sam.",
            "Can you take a look when you get a chance?",
            "I'll send this tomorrow.",
            "Okay, send this out.",
            "now",
            ""
        )) assertFalse(text, StopPhrase.endsWith(text, phrase))
    }

    @Test
    fun `strip cuts the phrase and the comma before it, and leaves everything else`() {
        assertEquals(
            "Hey Sam, I just pushed the fix. Can you take a look?",
            StopPhrase.strip("Hey Sam, I just pushed the fix. Can you take a look? Okay, send this now.", phrase)
        )
        assertEquals("Ship it on Friday", StopPhrase.strip("Ship it on Friday, okay send this now", phrase))
        assertEquals("", StopPhrase.strip("Okay, send this now.", phrase))
        assertNull(StopPhrase.strip("Okay, send this now, she said.", phrase))
    }

    @Test
    fun `once the phrase was heard while recording, a looser hearing of it in the whole clip is still cut`() {
        // Captured Oct 2026 (murmur-fast-transcribe): the probe heard "Okay, send this now.", the
        // whole recording "Okay, send this out."
        val whole = "Hey Sam, I just pushed the fix for the login bug. Can you take a look when you get a chance? Okay, send this out."
        assertNull(StopPhrase.strip(whole, phrase))
        assertEquals(
            "Hey Sam, I just pushed the fix for the login bug. Can you take a look when you get a chance?",
            StopPhrase.strip(whole, phrase, heard = true)
        )
        assertNull(StopPhrase.strip("Can you take a look when you get a chance?", phrase, heard = true))
    }

    @Test
    fun `a custom phrase works the same way, and an empty one listens for nothing`() {
        assertEquals("Lunch at noon.", StopPhrase.strip("Lunch at noon. Over and out.", "over and out"))
        assertEquals("Done.", StopPhrase.strip("Done. Murmur, send.", "murmur send"))
        assertFalse(StopPhrase.endsWith("anything at all", ""))
        assertFalse(StopPhrase.endsWith("anything at all", " , "))
    }

    // ---- the watcher on simulated audio --------------------------------------------------------

    private val rate = 16_000

    /** Tone bursts (speech) and silences (pauses), in seconds. */
    private fun audio(vararg parts: Pair<Boolean, Double>): ShortArray {
        val out = ArrayList<Short>()
        for ((voiced, sec) in parts) {
            val n = (sec * rate).toInt()
            for (i in 0 until n) out.add(if (voiced) (sin(i / 7.0) * 8000).toInt().toShort() else 0)
        }
        return out.toShortArray()
    }

    /** Feeds [pcm] to a watcher 80 ms at a time, as the listening loop does; returns the sample the match fired at. */
    private fun run(pcm: ShortArray, answers: (call: Int, clipSec: Double) -> String): Pair<Int?, List<Double>> {
        var fed = 0
        var matchedAt: Int? = null
        val clips = ArrayList<Double>()
        var clock = 0L
        val watcher = StopPhraseWatcher(
            CoroutineScope(Dispatchers.Unconfined),
            read = { from -> pcm.copyOfRange(minOf(from, fed), fed) },
            sampleRate = rate,
            phrase = phrase,
            now = { clock },
            transcribe = { clip -> clips.add(clip.size / rate.toDouble()); answers(clips.size, clip.size / rate.toDouble()) }
        ) { matchedAt = fed }
        val step = rate * 80 / 1000
        while (fed < pcm.size && matchedAt == null) {
            fed = minOf(pcm.size, fed + step)
            clock += 80
            watcher.poll(fed)
        }
        return matchedAt to clips
    }

    @Test
    fun `each pause after new speech is checked once, and the phrase at the end stops the session after a short pause`() {
        // speech, a 0.8 s pause, speech (ending with the phrase), then silence
        val pcm = audio(true to 3.0, false to 0.8, true to 2.5, false to 3.0)
        val (matchedAt, clips) = run(pcm) { call, _ -> if (call == 1) "Hey Sam, I pushed the fix." else "Can you look? Okay, send this now." }
        assertEquals("one probe per pause", 2, clips.size)
        assertTrue("probes stay short: $clips", clips.all { it <= 4.0 })
        val speechEnd = (6.3 * rate).toInt()
        assertTrue("fired after the pause: $matchedAt", matchedAt!! >= speechEnd + rate / 2)
        assertTrue("fired within 0.7 s of the last word: $matchedAt", matchedAt <= speechEnd + (0.7 * rate).toInt())
    }

    @Test
    fun `short gaps between words are not pauses, and without the phrase nothing stops`() {
        val pcm = audio(true to 1.0, false to 0.2, true to 1.0, false to 0.3, true to 1.0, false to 2.0)
        val (matchedAt, clips) = run(pcm) { _, _ -> "Can you take a look when you get a chance?" }
        assertNull(matchedAt)
        assertEquals("only the final pause is long enough", 1, clips.size)
    }

    @Test
    fun `speech after the probed pause means the phrase was not the end`() {
        var fed = 0
        val pcm = audio(true to 2.0, false to 0.6, true to 2.0, false to 2.0)
        var matched = false
        // The probe's answer arrives only after the speaker has started talking again.
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        var calls = 0
        val watcher = StopPhraseWatcher(
            scope,
            read = { from -> pcm.copyOfRange(minOf(from, fed), fed) },
            sampleRate = rate,
            phrase = phrase,
            now = { fed * 1000L / rate },
            transcribe = { calls++; if (calls == 1) { gate.await(); "Okay, send this now." } else "and then call Sam." }
        ) { matched = true }
        val step = rate * 80 / 1000
        while (fed < pcm.size) {
            fed = minOf(pcm.size, fed + step)
            watcher.poll(fed)
            if (fed >= (3.5 * rate).toInt() && !gate.isCompleted) gate.complete(Unit)
        }
        assertFalse("the first probe answered after more speech; it must not stop the session", matched)
        assertEquals(2, calls)
    }

    @Test
    fun `a closed watcher sends nothing more`() {
        var fed = 0
        val pcm = audio(true to 2.0, false to 2.0)
        var calls = 0
        val watcher = StopPhraseWatcher(
            CoroutineScope(Dispatchers.Unconfined),
            read = { from -> pcm.copyOfRange(minOf(from, fed), fed) },
            sampleRate = rate,
            phrase = phrase,
            transcribe = { calls++; "" }
        ) { }
        watcher.close()
        fed = pcm.size
        watcher.poll(fed)
        assertEquals(0, calls)
    }
}
