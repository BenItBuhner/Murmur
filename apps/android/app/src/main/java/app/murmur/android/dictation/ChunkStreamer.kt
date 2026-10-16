package app.murmur.android.dictation

import app.murmur.android.stt.adaptiveThreshold
import app.murmur.android.stt.rmsDb
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/**
 * Where to cut a long dictation while it is still being spoken, matching the desktop
 * (apps/desktop/src/core/audio/chunker.ts). Oct 2026: 300 ms pauses cut mid-sentence, so only
 * pauses of 700 ms and more are taken, and pieces may run to 30 s.
 */
data class ChunkPlan(
    val minSec: Double = 18.0,
    val maxSec: Double = 30.0,
    val pauseMs: Int = 700,
    val fallbackPauseMs: Int = 240
)

private const val FRAME_MS = 20

/**
 * Pieces sent at once (desktop: MAX_PIECES_IN_FLIGHT). A long session on a slow network queues the
 * rest instead of opening one request per piece (a 30-minute dictation is ~200 pieces).
 */
const val MAX_PIECES_IN_FLIGHT = 4
/** A piece that fails is sent once more before the dictation falls back to slower paths. */
const val PIECE_RETRIES = 1
/** Clips longer than this are transcribed in pieces, never as one request (the gateway caps a clip at 600 s). */
const val LONG_CLIP_SEC = 240.0

/** Audio repeated at the start of the next piece after a cut that may split a word. */
const val FORCED_OVERLAP_SEC = 1.0
/** After a clean cut, the next piece starts this far back (still inside the pause). */
const val PAUSE_LEAD_IN_SEC = 0.3

/** A cut: sample index, the pause it sits in (ms), and whether it may split a word. */
data class ChunkCut(val at: Int, val pauseMs: Int, val forced: Boolean)

fun findChunkCutDetail(pcm: ShortArray, sampleRate: Int, thresholdDb: Double, plan: ChunkPlan = ChunkPlan()): ChunkCut? {
    val frame = sampleRate * FRAME_MS / 1000
    val from = (plan.minSec * sampleRate).toInt()
    if (pcm.size < from + frame) return null
    val need = (plan.pauseMs + FRAME_MS - 1) / FRAME_MS
    val maxAt = (plan.maxSec * sampleRate).toInt()
    val limit = minOf(pcm.size, maxAt)
    var run = 0
    var best = 0
    var bestEnd = -1
    var quietest = -1
    var quietestDb = Double.MAX_VALUE
    var at = from
    while (at + frame <= limit) {
        val db = rmsDb(pcm, at, at + frame)
        if (db < quietestDb) { quietestDb = db; quietest = at }
        if (db < thresholdDb) {
            run++
            if (run > best) { best = run; bestEnd = at + frame }
            if (run >= need) return ChunkCut(at + frame - run * frame / 2, run * FRAME_MS, false)
        } else run = 0
        at += frame
    }
    if (pcm.size < maxAt) return null
    if (best * FRAME_MS >= plan.fallbackPauseMs) return ChunkCut(bestEnd - best * frame / 2, best * FRAME_MS, false)
    return if (quietest >= 0) ChunkCut(quietest + frame / 2, 0, true) else null
}

/** How often the stretch after the last piece is checked for a pause to speculate up to. */
const val SPEC_CHECK_SEC = 0.5
/** A new speculation needs at least this much more audio than the last one covered. */
const val SPEC_MIN_GAIN_SEC = 2.0
/** Pauses at least this long are speculation points (the join repairs mid-sentence ones). */
const val SPEC_PAUSE_MS = 600

/**
 * The last pause of at least [minPauseMs] in `pcm` that has ended, at least [minSec] in; mirrors
 * findSpecCut in apps/desktop/src/core/audio/chunker.ts.
 */
fun findSpecCut(pcm: ShortArray, sampleRate: Int, thresholdDb: Double, minPauseMs: Int = SPEC_PAUSE_MS, minSec: Double = 2.0): ChunkCut? {
    val frame = sampleRate * FRAME_MS / 1000
    val need = (minPauseMs + FRAME_MS - 1) / FRAME_MS
    val from = (minSec * sampleRate).toInt()
    var run = 0
    var best: ChunkCut? = null
    var at = 0
    while (at + frame <= pcm.size) {
        if (rmsDb(pcm, at, at + frame) < thresholdDb) run++
        else {
            if (run >= need && at >= from) best = ChunkCut(at - run * frame / 2, run * FRAME_MS, false)
            run = 0
        }
        at += frame
    }
    return best
}

/** Sample index to cut `pcm` at, or null to keep listening. */
fun findChunkCut(pcm: ShortArray, sampleRate: Int, thresholdDb: Double, plan: ChunkPlan = ChunkPlan()): Int? =
    findChunkCutDetail(pcm, sampleRate, thresholdDb, plan)?.at

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
    /**
     * Speculates on the stretch after the last piece, up to a pause, while the user keeps talking
     * (null: never). Told about it like [onPiece], with the number of pieces before it.
     */
    private val onSpec: ((pieces: Int, text: Deferred<String>) -> Unit)? = null,
    maxPiecesInFlight: Int = MAX_PIECES_IN_FLIGHT,
    private val transcribe: suspend (pcm: ShortArray, index: Int) -> String
) {
    private val gate = Semaphore(maxPiecesInFlight)

    /** One piece: queued behind the others in flight, and sent once more if it fails. */
    private suspend fun send(piece: ShortArray, index: Int): String {
        var left = PIECE_RETRIES
        while (true) {
            try {
                return gate.withPermit { transcribe(piece, index) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (left-- <= 0) throw e
            }
        }
    }

    private var committed = 0
    /** Samples before [committed] the next piece (or the tail) repeats. */
    private var overlap = 0
    private val pieces = ArrayList<Deferred<String>>()
    private var nextCheck = (plan.minSec * sampleRate).toInt()
    @Volatile private var closed = false
    private var specAt = -1
    private var specRestFrom = 0
    private var specText: Deferred<String>? = null
    private var nextSpecCheck = 0

    @Synchronized
    fun poll(totalSamples: Int) {
        if (closed) return
        maybeSpeculate(totalSamples)
        if (totalSamples - committed < nextCheck) return
        val pending = read(committed)
        val found = findChunkCutDetail(pending, sampleRate, adaptiveThreshold(pending, sampleRate, floorDb), plan)
        if (found == null) {
            nextCheck = pending.size + sampleRate / 4
            return
        }
        val cut = found.at
        val piece = if (overlap > 0) read(committed - overlap).copyOfRange(0, overlap + cut) else pending.copyOfRange(0, cut)
        val index = pieces.size
        val text = scope.async { send(piece, index) }
        pieces.add(text)
        onPiece(index, text)
        committed += cut
        specText = null // the piece covers it
        specAt = -1
        nextSpecCheck = 0
        val leadIn = if (found.forced) FORCED_OVERLAP_SEC else minOf(PAUSE_LEAD_IN_SEC, maxOf(0.0, found.pauseMs / 2000.0 - 0.05))
        overlap = minOf(cut, (leadIn * sampleRate).toInt())
        nextCheck = (plan.minSec * sampleRate).toInt()
    }

    private fun maybeSpeculate(total: Int) {
        val notify = onSpec ?: return
        // Short dictations never reach a piece cut (~18 s). Speculating on them makes release wait
        // for an in-flight STT+format of almost the whole clip. Only speculate after a piece.
        if (committed == 0) return
        if (total - committed < nextSpecCheck) return
        nextSpecCheck = total - committed + (SPEC_CHECK_SEC * sampleRate).toInt()
        val pending = read(committed)
        val cut = findSpecCut(pending, sampleRate, adaptiveThreshold(pending, sampleRate, floorDb)) ?: return
        if (specAt >= 0 && cut.at < specAt + SPEC_MIN_GAIN_SEC * sampleRate) return
        val pcm = if (overlap > 0) read(committed - overlap).copyOfRange(0, overlap + cut.at) else pending.copyOfRange(0, cut.at)
        val index = pieces.size
        val text = scope.async { transcribe(pcm, index) }
        val lead = (minOf(PAUSE_LEAD_IN_SEC, maxOf(0.0, cut.pauseMs / 2000.0 - 0.05)) * sampleRate).toInt()
        specAt = cut.at
        specRestFrom = cut.at - lead
        specText = text
        notify(index, text)
    }

    val piecesSent: Int @Synchronized get() = pieces.size

    /** Whether there is anything to hand over at release: a piece or a tail speculation. */
    val hasWork: Boolean @Synchronized get() = pieces.isNotEmpty() || specText != null

    @Synchronized
    fun finish(): Streamed {
        closed = true
        val all = ArrayList(pieces)
        val spec = specText
        return Streamed(committed - overlap, spec?.let { committed + specRestFrom }, spec) { all.awaitAll() }
    }
}

/** What was transcribed while the user spoke: samples covered, and the pieces' texts. */
class Streamed(
    val samples: Int,
    /** Where the audio after the tail speculation starts, when there is one. */
    val specSamples: Int? = null,
    val specText: Deferred<String>? = null,
    val texts: suspend () -> List<String>
)

/**
 * Transcribes a recording that is already complete in pieces cut at pauses, the same way pieces
 * are cut while recording, at most [MAX_PIECES_IN_FLIGHT] at a time (desktop: transcribeInPieces).
 * For a long dictation whose streamed pieces failed, and for Retry of one: a 30-minute clip never
 * goes up as one request. The last text is the rest after the final cut.
 */
suspend fun transcribeInPieces(
    pcm: ShortArray,
    sampleRate: Int,
    floorDb: Double,
    plan: ChunkPlan = ChunkPlan(),
    transcribe: suspend (pcm: ShortArray, index: Int) -> String
): List<String> = coroutineScope {
    var total = 0
    val streamer = ChunkStreamer(this, { from -> pcm.copyOfRange(minOf(from, total), total) }, sampleRate, floorDb, plan, transcribe = transcribe)
    val step = sampleRate / 4
    total = minOf(step, pcm.size)
    while (true) {
        streamer.poll(total)
        if (total >= pcm.size) break
        total = minOf(total + step, pcm.size)
    }
    val done = streamer.finish()
    val rest = pcm.copyOfRange(minOf(done.samples, pcm.size), pcm.size)
    val pieces = done.texts()
    val last = if (rest.size >= sampleRate / 4) transcribe(rest, pieces.size) else ""
    pieces + last
}

/** Above this many words, a whole transcript is formatted in groups (desktop: LONG_FORMAT_WORDS). */
const val LONG_FORMAT_WORDS = 600
/** Words per group when a long transcript is formatted in groups, cut at sentence ends. */
const val FORMAT_GROUP_WORDS = 250

/** Splits a transcript at sentence ends into groups of about [size] words (desktop: formatGroups). */
fun formatGroups(text: String, size: Int = FORMAT_GROUP_WORDS): List<String> {
    val sentences = text.trim().split(Regex("(?<=[.!?])\\s+"))
    val groups = ArrayList<String>()
    val cur = ArrayList<String>()
    var words = 0
    for (sentence in sentences) {
        val n = sentence.split(Regex("\\s+")).count { it.isNotEmpty() }
        if (words > 0 && words + n > size) {
            groups.add(cur.joinToString(" "))
            cur.clear()
            words = 0
        }
        cur.add(sentence)
        words += n
    }
    if (cur.isNotEmpty()) groups.add(cur.joinToString(" "))
    return groups
}
