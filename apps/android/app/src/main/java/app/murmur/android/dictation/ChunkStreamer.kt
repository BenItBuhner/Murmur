package app.murmur.android.dictation

import app.murmur.android.stt.adaptiveThreshold
import app.murmur.android.stt.rmsDb
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll

/**
 * Where to cut a long dictation while it is still being spoken, matching the desktop
 * (apps/desktop/src/core/audio/chunker.ts). Bench (Oct 2026, 2-5 min clips): 15 s pieces sent
 * during recording leave ~0.25 s of recognition after release, with unchanged word error rate.
 */
data class ChunkPlan(val minSec: Double = 15.0, val maxSec: Double = 28.0, val pauseMs: Int = 300)

private const val FRAME_MS = 20

/** Sample index to cut `pcm` at, or null to keep listening. */
fun findChunkCut(pcm: ShortArray, sampleRate: Int, thresholdDb: Double, plan: ChunkPlan = ChunkPlan()): Int? {
    val frame = sampleRate * FRAME_MS / 1000
    val from = (plan.minSec * sampleRate).toInt()
    if (pcm.size < from + frame) return null
    val need = (plan.pauseMs + FRAME_MS - 1) / FRAME_MS
    val maxAt = (plan.maxSec * sampleRate).toInt()
    val limit = minOf(pcm.size, maxAt)
    var run = 0
    var quietest = -1
    var quietestDb = Double.MAX_VALUE
    var at = from
    while (at + frame <= limit) {
        val db = rmsDb(pcm, at, at + frame)
        if (db < quietestDb) { quietestDb = db; quietest = at }
        if (db < thresholdDb) {
            run++
            if (run >= need) return at + frame - run * frame / 2
        } else run = 0
        at += frame
    }
    return if (pcm.size >= maxAt && quietest >= 0) quietest + frame / 2 else null
}

/**
 * Sends a long dictation to speech recognition in pieces while it is spoken. [poll] is called
 * from the listening loop; at release [finish] says how many samples the pieces cover.
 */
class ChunkStreamer(
    private val scope: CoroutineScope,
    private val read: (from: Int) -> ShortArray,
    private val sampleRate: Int,
    private val floorDb: Double,
    private val plan: ChunkPlan = ChunkPlan(),
    /** Told about each piece as it is sent, in order (for formatting it once its text is in). */
    private val onPiece: (index: Int, text: Deferred<String>) -> Unit = { _, _ -> },
    private val transcribe: suspend (pcm: ShortArray, index: Int) -> String
) {
    private var committed = 0
    private val pieces = ArrayList<Deferred<String>>()
    private var nextCheck = (plan.minSec * sampleRate).toInt()
    @Volatile private var closed = false

    @Synchronized
    fun poll(totalSamples: Int) {
        if (closed || totalSamples - committed < nextCheck) return
        val pending = read(committed)
        val cut = findChunkCut(pending, sampleRate, adaptiveThreshold(pending, sampleRate, floorDb), plan)
        if (cut == null) {
            nextCheck = pending.size + sampleRate / 4
            return
        }
        val piece = pending.copyOfRange(0, cut)
        val index = pieces.size
        val text = scope.async { transcribe(piece, index) }
        pieces.add(text)
        onPiece(index, text)
        committed += cut
        nextCheck = (plan.minSec * sampleRate).toInt()
    }

    val piecesSent: Int @Synchronized get() = pieces.size

    @Synchronized
    fun finish(): Streamed {
        closed = true
        val all = ArrayList(pieces)
        return Streamed(committed) { all.awaitAll() }
    }
}

/** What was transcribed while the user spoke: samples covered, and the pieces' texts. */
class Streamed(val samples: Int, val texts: suspend () -> List<String>)
