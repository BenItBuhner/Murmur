package app.murmur.android.allday

import kotlin.math.log10
import kotlin.math.sqrt

/** One piece of the all-day recording, ready to transcribe (or not, when it is silent). */
class Piece(val pcm: ShortArray, val startedAtMs: Long, val endedAtMs: Long, val rmsDb: Double, val speechRatio: Double) {
    val silent: Boolean get() = speechRatio < 0.02
}

/**
 * Cuts the microphone's stream into pieces of about 25 seconds at a quiet moment (never more than
 * 40), the same shape the desktop's all-day recorder uses. Only the current piece is held in memory,
 * so it can run all day. Pure Kotlin so it is unit-tested on the JVM.
 */
class AllDayPieces(private val sampleRate: Int = 16_000, private val clock: () -> Long = System::currentTimeMillis) {
    private val target = sampleRate * 25
    private val max = sampleRate * 40
    private val frame = sampleRate / 20 // 50 ms
    private var buf = ShortArray(max + sampleRate)
    private var size = 0
    private var startedAtMs = -1L

    /** Adds samples; returns any piece that is finished. */
    fun push(samples: ShortArray, count: Int = samples.size): List<Piece> {
        val out = ArrayList<Piece>(1)
        if (startedAtMs < 0) startedAtMs = clock() - count * 1000L / sampleRate
        var i = 0
        while (i < count) {
            // Up to the target at once, then a second at a time, so a cut is looked for at least
            // every second and the hard limit is never passed.
            val room = if (size < target) target - size else minOf(sampleRate, max - size)
            val n = minOf(count - i, maxOf(room, 0))
            System.arraycopy(samples, i, buf, size, n)
            size += n
            i += n
            if (size >= target) cut(false)?.let(out::add)
            if (n == 0 && size >= max) cut(true)?.let(out::add)
        }
        return out
    }

    /** Ends the current piece now (the recording stopped). */
    fun flush(): Piece? = cut(true)

    private fun cut(final: Boolean): Piece? {
        if (size == 0) return null
        val at = if (final) size else quietCut() ?: return null
        val pcm = buf.copyOf(at)
        System.arraycopy(buf, at, buf, 0, size - at)
        size -= at
        val start = startedAtMs
        val end = start + at * 1000L / sampleRate
        startedAtMs = end
        val (db, ratio) = stats(pcm)
        return Piece(pcm, start, end, db, ratio)
    }

    /** The quietest 50 ms in the last 6 seconds, if it is quiet enough or the piece is at its limit. */
    private fun quietCut(): Int? {
        val from = maxOf(0, size - sampleRate * 6)
        var best = -1
        var bestDb = Double.MAX_VALUE
        var f = from
        while (f + frame <= size) {
            val db = levelDb(buf, f, frame)
            if (db < bestDb) { bestDb = db; best = f }
            f += frame
        }
        if (best < 0) return if (size >= max) size else null
        if (bestDb >= -45 && size < max) return null
        return best + frame / 2
    }

    private fun stats(pcm: ShortArray): Pair<Double, Double> {
        var frames = 0
        var loud = 0
        var sum = 0.0
        var f = 0
        while (f + frame <= pcm.size) {
            val db = levelDb(pcm, f, frame)
            sum += db
            frames++
            if (db > -45) loud++
            f += frame
        }
        if (frames == 0) return -90.0 to 0.0
        return Math.round(sum / frames * 10) / 10.0 to Math.round(loud * 100.0 / frames) / 100.0
    }

    private fun levelDb(pcm: ShortArray, from: Int, n: Int): Double {
        var acc = 0.0
        for (k in from until from + n) { val s = pcm[k] / 32768.0; acc += s * s }
        return 20 * log10(maxOf(1e-6, sqrt(acc / n)))
    }
}
