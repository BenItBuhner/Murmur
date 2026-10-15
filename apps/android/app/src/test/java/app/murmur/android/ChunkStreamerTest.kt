package app.murmur.android

import app.murmur.android.dictation.ChunkStreamer
import app.murmur.android.dictation.findChunkCut
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sin

/** Mirrors apps/desktop/tests/chunker.test.ts and the streaming session test. */
class ChunkStreamerTest {
    private val rate = 16_000
    private fun loud(sec: Double) = ShortArray((sec * rate).toInt()) { (sin(it / 9.0) * 9000).toInt().toShort() }

    @Test
    fun `waits for the minimum, then cuts inside the first pause`() {
        assertNull(findChunkCut(loud(15.0), rate, -30.0))
        val p = loud(22.0)
        p.fill(0, 19 * rate, (19.9 * rate).toInt())
        val cut = findChunkCut(p, rate, -30.0)!!
        assertTrue(cut > 19.2 * rate && cut < 19.7 * rate)
        // A breath-length pause is not a cut before the maximum.
        val breath = loud(25.0)
        breath.fill(0, 20 * rate, (20.35 * rate).toInt())
        assertNull(findChunkCut(breath, rate, -30.0))
    }

    @Test
    fun `streams pieces and reports what they cover`() = runBlocking {
        val clip = loud(50.0)
        for (s in generateSequence(3.4) { it + 4 }.takeWhile { it < 50 }) clip.fill(0, (s * rate).toInt(), ((s + 0.8) * rate).toInt())
        var fed = 0
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val streamer = ChunkStreamer(scope, { from -> clip.copyOfRange(from, fed) }, rate, -48.0) { pcm, i -> "piece$i:${pcm.size}" }
        while (fed < clip.size) {
            fed = minOf(clip.size, fed + 1600)
            streamer.poll(fed)
        }
        val streamed = streamer.finish()
        val texts = streamed.texts()
        assertTrue(texts.size >= 2)
        // Pieces after the first start a little before their cut (a lead-in inside the pause).
        val sizes = texts.map { it.substringAfter(':').toInt() }
        assertTrue(streamed.samples <= sizes.sum())
        assertTrue(sizes.sum() - streamed.samples <= texts.size * (0.3 * rate).toInt())
        assertTrue(clip.size - streamed.samples < 30 * rate)
    }
}
