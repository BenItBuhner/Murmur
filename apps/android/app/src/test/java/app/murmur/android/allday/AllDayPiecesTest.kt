package app.murmur.android.allday

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sin

class AllDayPiecesTest {
    private fun tone(secs: Int) = ShortArray(secs * 16_000) { (8000 * sin(it / 8.0)).toInt().toShort() }

    @Test
    fun silenceCutsAtTargetAndIsMarkedSilent() {
        var t = 0L
        val cutter = AllDayPieces(clock = { t })
        val out = ArrayList<Piece>()
        repeat(30) { t += 1000; out += cutter.push(ShortArray(16_000)) }
        cutter.flush()?.let(out::add)
        assertEquals(2, out.size)
        assertTrue(out.all { it.silent })
        assertEquals(out[0].endedAtMs, out[1].startedAtMs)
    }

    @Test
    fun loudSpeechIsCutAtTheHardLimit() {
        val cutter = AllDayPieces(clock = { 0L })
        val out = cutter.push(tone(45))
        assertEquals(1, out.size)
        assertTrue(out[0].pcm.size in 34 * 16_000..40 * 16_000)
        assertTrue(!out[0].silent && out[0].speechRatio > 0.9)
    }

    @Test
    fun uploadUrlCarriesThePiece() {
        val p = Piece(ShortArray(0), 0, 25_000, -30.0, 0.8)
        val url = AllDay.uploadUrl("https://x.convex.site/", "phone:a b", p)
        assertEquals(
            "https://x.convex.site/v1/timeline/audio?device=phone%3Aa+b&startedAt=1970-01-01T00%3A00%3A00Z&endedAt=1970-01-01T00%3A00%3A25Z",
            url
        )
    }
}
