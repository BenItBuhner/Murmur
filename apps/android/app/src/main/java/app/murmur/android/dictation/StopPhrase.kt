package app.murmur.android.dictation

import app.murmur.android.stt.adaptiveThreshold
import app.murmur.android.text.Hallucination
import app.murmur.android.stt.rmsDb
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * A spoken stop phrase ("okay, send this now"): said at the very end of a dictation it ends the
 * recording the way a second tap does, and it never reaches the text.
 *
 * Speech recognition here works on finished audio (pieces cut at pauses, the rest at release), so
 * nothing listens word by word. Instead, every time the speaker pauses, the last few seconds are
 * transcribed on their own ([StopPhraseWatcher]); when that text ends with the phrase and the
 * speaker is still quiet, the dictation stops. The phrase is then cut from the end of the full
 * transcript ([StopPhrase.strip]) before formatting.
 */
object StopPhrase {
    const val DEFAULT = "okay, send this now"

    /** Spoken forms the speech model writes differently for the same word. */
    private val SAME = mapOf("ok" to "okay", "k" to "okay", "kay" to "okay", "alright" to "allright")

    /** One word of a transcript: its normalized form and where it sits in the original text. */
    private data class Word(val norm: String, val start: Int, val end: Int)

    private fun words(text: String): List<Word> {
        val out = ArrayList<Word>()
        // Letters, digits and the apostrophes and dots inside a word ("O.K.", "don't").
        Regex("[\\p{L}\\p{N}]+(?:['’.][\\p{L}\\p{N}]+)*\\.?").findAll(text).forEach { m ->
            val bare = m.value.lowercase().replace(Regex("['’.]"), "")
            if (bare.isNotEmpty()) out.add(Word(SAME[bare] ?: bare, m.range.first, m.range.last + 1))
        }
        return out
    }

    /** The phrase's words as they are compared, or empty when there is nothing to listen for. */
    fun normalized(phrase: String): List<String> = words(phrase).map { it.norm }

    private fun distance(a: String, b: String): Int {
        if (a == b) return 0
        var prev = IntArray(b.length + 1) { it }
        for (i in 1..a.length) {
            val cur = IntArray(b.length + 1)
            cur[0] = i
            for (j in 1..b.length) {
                cur[j] = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + if (a[i - 1] == b[j - 1]) 0 else 1)
            }
            prev = cur
        }
        return prev[b.length]
    }

    /**
     * Where the phrase starts in [text] when the text ends with it, or -1. Case, punctuation and
     * "ok"/"okay" do not matter, and a slightly different hearing does ("send these now"): about one
     * letter in six may differ, and a phrase of three or more words may lose or gain a word.
     *
     * [heard]: the phrase was already heard at the end while recording, so the full transcript is
     * known to end with it; up to a third of the letters may then differ, since the same words are
     * sometimes heard differently in a longer clip (Oct 2026: a probe heard "okay, send this now",
     * the whole recording "okay, send this out").
     */
    fun matchStart(text: String, phrase: String, heard: Boolean = false): Int {
        val want = normalized(phrase)
        if (want.isEmpty()) return -1
        val have = words(text)
        val target = want.joinToString("")
        val allowed = when {
            target.length < 4 -> 0
            heard -> target.length / 3
            else -> maxOf(1, target.length / 6)
        }
        var best = -1
        var bestDistance = Int.MAX_VALUE
        val counts = if (want.size >= 3) listOf(want.size, want.size - 1, want.size + 1) else listOf(want.size)
        for (k in counts) {
            if (k < 1 || k > have.size) continue
            val tail = have.subList(have.size - k, have.size)
            val d = distance(tail.joinToString("") { it.norm }, target)
            if (d <= allowed && d < bestDistance) {
                bestDistance = d
                best = tail.first().start
            }
        }
        return best
    }

    fun endsWith(text: String, phrase: String): Boolean = matchStart(text, phrase) >= 0

    /**
     * [text] without the stop phrase at its end (and the comma or space before it), or null when
     * the text does not end with it. [heard] as for [matchStart].
     */
    fun strip(text: String, phrase: String, heard: Boolean = false): String? {
        var body = text
        var at = matchStart(body, phrase, heard)
        // Heard while recording, nothing was said after the phrase: a stock line after it ("Thank
        // you.") is the speech model talking to the silence that followed (Oct 2026: a 30 s
        // dictation came back as "... Okay, send this now. Thank you.").
        while (at < 0 && heard) {
            val last = lastSentence(body) ?: break
            if (!Hallucination.isSilencePhrase(body.substring(last))) break
            body = body.substring(0, last).trimEnd()
            at = matchStart(body, phrase, heard)
        }
        if (at < 0) return null
        return body.substring(0, at).trimEnd { it.isWhitespace() || it == ',' || it == ';' || it == ':' || it == '-' || it == '—' }
    }

    /** Where the last sentence of [text] starts, or null when there is only one. */
    private fun lastSentence(text: String): Int? {
        val trimmed = text.trimEnd()
        val end = trimmed.trimEnd('.', '!', '?', '…').length
        val cut = trimmed.lastIndexOfAny(charArrayOf('.', '!', '?', '…'), end - 1)
        return if (cut <= 0) null else cut + 1
    }
}

/** A pause at least this long after speech is when the end of what was said is checked. */
const val STOP_PHRASE_PAUSE_MS = 500
/** Probes start at most this often, however often the speaker pauses. */
const val STOP_PHRASE_MIN_GAP_MS = 1_000

private const val FRAME_MS = 20

/**
 * Listens for the stop phrase while recording. [poll] is called from the listening loop with the
 * number of samples captured so far; when the speaker has paused after new speech, the last few
 * seconds of it go to [transcribe] (one request at a time), and [onMatch] fires when that text ends
 * with the phrase and nothing has been said since.
 */
class StopPhraseWatcher(
    private val scope: CoroutineScope,
    private val read: (from: Int) -> ShortArray,
    private val sampleRate: Int,
    private val phrase: String,
    private val floorDb: Double = -48.0,
    private val pauseMs: Int = STOP_PHRASE_PAUSE_MS,
    private val now: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
    private val transcribe: suspend (pcm: ShortArray) -> String,
    /** [speechEnd]: the sample where the phrase ended; what follows is silence. */
    private val onMatch: (heard: String, speechEnd: Int) -> Unit
) {
    private val words = StopPhrase.normalized(phrase).size

    /** Audio sent per probe: the phrase at an unhurried pace, plus a little before it for context. */
    private val windowSamples = ((1.5 + 0.45 * words).coerceIn(2.5, 7.0) * sampleRate).toInt()

    /** How far back each poll looks for the end of speech. */
    private val lookback = windowSamples + sampleRate * 2

    /** Where speech ended at the last probe (sample index); a new probe needs speech after it. */
    private var probedEnd = -1
    /** Where speech last ended as seen by [poll], so a probe's answer can tell if more was said. */
    @Volatile private var lastSpeechEnd = -1
    private var inFlight: Job? = null
    private var lastProbeAt = 0L
    @Volatile private var fired = false

    val probes: Int get() = probeCount
    private var probeCount = 0

    @Synchronized
    fun poll(totalSamples: Int) {
        if (fired || words == 0) return
        val from = maxOf(0, totalSamples - lookback)
        val pcm = read(from)
        if (pcm.isEmpty()) return
        val frame = sampleRate * FRAME_MS / 1000
        val threshold = adaptiveThreshold(pcm, sampleRate, floorDb)
        // Walk back over the quiet frames at the end.
        var quiet = 0
        var at = pcm.size - frame
        while (at >= 0 && rmsDb(pcm, at, at + frame) < threshold) {
            quiet++
            at -= frame
        }
        if (at < 0) return // nothing voiced in view
        val speechEnd = from + at + frame
        lastSpeechEnd = speechEnd
        if (quiet * FRAME_MS < pauseMs) return
        if (speechEnd <= probedEnd) return
        if (inFlight?.isActive == true) return
        if (now() - lastProbeAt < STOP_PHRASE_MIN_GAP_MS) return
        // A little of the pause after the last word, so the model hears it end.
        val clipEnd = minOf(totalSamples, speechEnd + sampleRate / 4)
        val clipStart = maxOf(0, speechEnd - windowSamples)
        val clip = read(clipStart).copyOfRange(0, clipEnd - clipStart)
        probedEnd = speechEnd
        lastProbeAt = now()
        probeCount++
        inFlight = scope.launch {
            val heard = try {
                transcribe(clip)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log("stop phrase probe failed: ${e.message}")
                return@launch
            }
            val match = StopPhrase.endsWith(heard, phrase)
            log("stop phrase probe: \"${heard.takeLast(60)}\" ${if (match) "matches" else "no match"}")
            if (!match) return@launch
            synchronized(this@StopPhraseWatcher) {
                // Speech after the probed stretch means the phrase was not the end after all.
                if (fired || lastSpeechEnd > speechEnd + frame * 2) return@launch
                fired = true
            }
            onMatch(heard, speechEnd)
        }
    }

    /** Stops listening; a probe still running is dropped. */
    @Synchronized
    fun close() {
        fired = true
        inFlight?.cancel()
    }
}
