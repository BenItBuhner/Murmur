package app.murmur.android

import app.murmur.android.dictation.ChunkPlan
import app.murmur.android.dictation.ChunkStreamer
import app.murmur.android.dictation.FORMAT_GROUP_WORDS
import app.murmur.android.dictation.LONG_CLIP_SEC
import app.murmur.android.dictation.MAX_PIECES_IN_FLIGHT
import app.murmur.android.dictation.formatGroups
import app.murmur.android.dictation.releaseDeadlineMs
import app.murmur.android.dictation.transcribeInPieces
import app.murmur.android.history.PartialStore
import app.murmur.android.history.PartialTranscript
import app.murmur.android.history.RECOVERED_NOTE
import app.murmur.android.history.recoveredEntry
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import kotlin.math.sin

/** A simulated 30-minute dictation; mirrors apps/desktop/tests/long-session.test.ts. */
class LongSessionTest {
    @get:Rule val tmp = TemporaryFolder()
    private val rate = 16_000
    private val minutes = 30

    /** Tone bursts of 2-7 s with 0.25-1.2 s pauses, deterministic: 28.8 M samples. */
    private fun speech(): ShortArray {
        val pcm = ShortArray(minutes * 60 * rate)
        var at = 0
        var k = 0
        while (at < pcm.size) {
            val burst = ((2 + ((k * 37) % 50) / 10.0) * rate).toInt()
            for (i in at until minOf(pcm.size, at + burst)) pcm[i] = (sin(i / 9.0) * 9000).toInt().toShort()
            at += burst + ((0.25 + ((k * 13) % 10) / 10.0) * rate).toInt()
            k++
        }
        return pcm
    }

    @Test
    fun `30 minutes stream in bounded pieces, at most MAX_PIECES_IN_FLIGHT at once, and a failed piece is retried`() = runBlocking {
        val pcm = speech()
        val active = AtomicInteger()
        val peak = AtomicInteger()
        val calls = java.util.concurrent.ConcurrentHashMap<Int, AtomicInteger>()
        val plan = ChunkPlan()
        var fed = 0
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val streamer = ChunkStreamer(scope, { from -> pcm.copyOfRange(minOf(from, fed), fed) }, rate, -60.0) { piece, i ->
            val n = active.incrementAndGet()
            peak.accumulateAndGet(n) { a, b -> maxOf(a, b) }
            val attempt = calls.getOrPut(i) { AtomicInteger() }.incrementAndGet()
            try {
                delay(2)
                if (i == 7 && attempt == 1) throw java.io.IOException("connection reset")
                assertTrue(piece.size <= ((plan.maxSec + 1.01) * rate).toInt())
                "piece $i."
            } finally {
                active.decrementAndGet()
            }
        }
        while (fed < pcm.size) {
            fed = minOf(pcm.size, fed + rate / 10)
            streamer.poll(fed)
        }
        val done = streamer.finish()
        val texts = done.texts()
        assertTrue(texts.size >= minutes * 60 / plan.maxSec.toInt())
        assertTrue(texts.size <= minutes * 60 / plan.minSec.toInt() + 1)
        assertEquals("piece 7.", texts[7])
        assertEquals(2, calls[7]!!.get())
        assertTrue("peak ${peak.get()}", peak.get() <= MAX_PIECES_IN_FLIGHT)
        assertTrue(pcm.size - done.samples < (plan.maxSec + 2) * rate)
    }

    @Test
    fun `a long recording sent again goes up in pieces under the gateway clip cap`() = runBlocking {
        val pcm = speech()
        val active = AtomicInteger()
        val peak = AtomicInteger()
        var longest = 0.0
        val texts = transcribeInPieces(pcm, rate, -60.0) { clip, i ->
            val n = active.incrementAndGet()
            peak.accumulateAndGet(n) { a, b -> maxOf(a, b) }
            synchronized(this@LongSessionTest) { longest = maxOf(longest, clip.size.toDouble() / rate) }
            delay(1)
            active.decrementAndGet()
            "t$i"
        }
        assertTrue(longest <= LONG_CLIP_SEC)
        assertTrue(longest <= ChunkPlan().maxSec + 1.01)
        assertTrue(peak.get() <= MAX_PIECES_IN_FLIGHT)
        assertTrue(texts.size > 50)
    }

    @Test
    fun `a long transcript is formatted in sentence groups, and the release deadline scales to 4 minutes`() {
        val sentence = "This is one sentence of a long dictation that keeps going on."
        val text = List(400) { sentence }.joinToString(" ")
        val groups = formatGroups(text)
        assertEquals(text, groups.joinToString(" "))
        groups.forEach {
            assertTrue(it.endsWith("."))
            assertTrue(it.split(Regex("\\s+")).size <= FORMAT_GROUP_WORDS + 12)
        }
        assertTrue(groups.size >= 19)
        assertEquals(33_000L, releaseDeadlineMs(30.0))
        assertEquals(210_000L, releaseDeadlineMs(1800.0))
        assertEquals(240_000L, releaseDeadlineMs(7200.0))
    }

    @Test
    fun `a partial transcript left by a crash becomes a History entry`() {
        val dir = tmp.newFolder("partials")
        val store = PartialStore(dir)
        store.save(PartialTranscript("a1", 1, "hold", listOf("First part of it.", null, "third part.")))
        store.save(PartialTranscript("b2", 2, "hands-free", listOf("done")))
        store.clear("b2")
        store.save(PartialTranscript("c3", 3, "hold", emptyList()))
        val left = PartialStore(dir).takeAll()
        assertEquals(listOf("a1", "c3"), left.map { it.id })
        assertTrue(PartialStore(dir).takeAll().isEmpty())
        val entry = recoveredEntry(left[0])!!
        assertEquals("First part of it third part.", entry.finalText)
        assertEquals(RECOVERED_NOTE, entry.error)
        assertEquals(listOf("recovered"), entry.stages)
        assertNull(recoveredEntry(left[1]))
    }
}
