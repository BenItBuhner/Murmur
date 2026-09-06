package app.murmur.android.stt

import app.murmur.android.audio.Wav
import app.murmur.android.text.countWords
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * Does the transcript account for the whole clip? Port of apps/desktop/src/core/stt/coverage.ts.
 *
 * Whisper-style decoders sometimes emit end-of-text long before the speech ends and the API
 * returns that partial transcript as if it were complete. The classic trigger is the vocabulary
 * prompt: the model reads the prompt as the previous segment, and when the speaker then says the
 * term that closed the prompt it copies what followed it in context — nothing — and stops right
 * there. The word timings say where it stopped, so the rest can be transcribed from that point.
 */

data class Coverage(
    /** End of the last timed word/segment, in seconds; null when the provider sent no timings. */
    val transcribedSec: Double?,
    /** Speech the transcript does not account for, in seconds (an estimate without timings). */
    val missingSec: Double,
    val truncated: Boolean,
    val reason: String? = null
)

data class CoverageOptions(
    /** Seconds the transcript may end before the speech does; timing jitter, a trailing pause. */
    val slackSec: Double = 2.5,
    /** ...and at least this share of the speech must be missing. */
    val minMissingRatio: Double = 0.08,
    /** Without timings: a transcript this sparse (words per second of speech) looks cut off. */
    val minWordsPerSec: Double = 0.8,
    /** Without timings: only judge the word rate on clips at least this long. */
    val minSpeechSecForRate: Double = 8.0
)

fun assessCoverage(out: TranscribeOutput, speechEndSec: Double, opts: CoverageOptions = CoverageOptions()): Coverage {
    if (speechEndSec.isNaN() || speechEndSec <= 0) return Coverage(null, 0.0, false)
    val words = countWords(out.text)
    if (words == 0) {
        val truncated = speechEndSec >= 3
        return Coverage(0.0, speechEndSec, truncated, if (truncated) "empty" else null)
    }
    val ends = (out.spans ?: emptyList()).map { it.end }.filter { !it.isNaN() && it >= 0 }
    if (ends.isNotEmpty()) {
        val last = ends.max()
        val missing = maxOf(0.0, speechEndSec - last)
        val truncated = missing > opts.slackSec && missing > opts.minMissingRatio * speechEndSec
        return Coverage(last, missing, truncated, if (truncated) "timestamps" else null)
    }
    if (speechEndSec >= opts.minSpeechSecForRate && words / speechEndSec < opts.minWordsPerSec) {
        return Coverage(null, maxOf(0.0, speechEndSec - words / 2.5), true, "rate")
    }
    return Coverage(null, 0.0, false)
}

// ---- light voice activity helpers (the desktop core has a VAD module; the phone only needs these) --

fun rmsDb(pcm: ShortArray, start: Int, end: Int): Double {
    var sum = 0.0
    val n = maxOf(1, end - start)
    for (i in start until end) {
        val s = pcm[i] / 32768.0
        sum += s * s
    }
    val rms = sqrt(sum / n)
    return if (rms <= 1e-9) -100.0 else 20 * log10(rms)
}

/** Noise floor estimate + margin, never below the configured value (desktop `adaptiveThreshold`). */
fun adaptiveThreshold(pcm: ShortArray, sampleRate: Int, configuredDb: Double): Double {
    val frameLen = sampleRate * 20 / 1000
    val frames = pcm.size / frameLen
    if (frames < 10) return configuredDb
    val levels = DoubleArray(frames) { f -> rmsDb(pcm, f * frameLen, (f + 1) * frameLen) }
    levels.sort()
    val noiseFloor = levels[(levels.size * 0.2).toInt()]
    return maxOf(configuredDb, noiseFloor + 12)
}

/** End of the last 20 ms frame above the threshold, in seconds; -1 when nothing is voiced. */
fun lastVoicedSec(pcm: ShortArray, sampleRate: Int, thresholdDb: Double): Double {
    val frameLen = maxOf(1, sampleRate * 20 / 1000)
    val frames = pcm.size / frameLen
    var last = -1
    for (f in 0 until frames) if (rmsDb(pcm, f * frameLen, (f + 1) * frameLen) >= thresholdDb) last = f
    return if (last < 0) -1.0 else (last + 1) * frameLen / sampleRate.toDouble()
}

/**
 * Where to split the audio when resuming after `targetSec`: the middle of the longest pause near
 * the target, so no word is cut in half. Falls back to just before the target.
 */
fun findCutPoint(
    pcm: ShortArray,
    sampleRate: Int,
    targetSec: Double,
    thresholdDb: Double,
    beforeSec: Double = 0.35,
    afterSec: Double = 1.5
): Double {
    val frameLen = maxOf(1, sampleRate * 20 / 1000)
    val totalSec = pcm.size / sampleRate.toDouble()
    val from = maxOf(0.0, targetSec - beforeSec)
    val to = minOf(totalSec, targetSec + afterSec)
    val f0 = (from * sampleRate / frameLen).toInt()
    val f1 = (to * sampleRate / frameLen).toInt()
    var bestStart = -1
    var bestLen = 0
    var runStart = -1
    var runLen = 0
    for (f in f0 until f1) {
        val end = minOf(pcm.size, (f + 1) * frameLen)
        if (rmsDb(pcm, f * frameLen, end) < thresholdDb) {
            if (runStart < 0) runStart = f
            runLen++
            if (runLen > bestLen) {
                bestLen = runLen
                bestStart = runStart
            }
        } else {
            runStart = -1
            runLen = 0
        }
    }
    if (bestLen >= 2) return (bestStart + bestLen / 2.0) * frameLen / sampleRate
    return maxOf(0.0, minOf(totalSec, targetSec - 0.1))
}

private val WORD_RE = Regex("[\\p{L}\\p{N}]+(?:['’][\\p{L}\\p{N}]+)*")

private fun wordsOf(s: String): List<Pair<String, Int>> =
    WORD_RE.findAll(s).map { it.value.lowercase().replace('’', '\'') to it.range.last + 1 }.toList()

/**
 * Append a resumed tail to the transcript so far. The cut sits in a pause, but the tail may still
 * repeat the last word or two of the head; a matching run at the seam is dropped from the tail.
 */
fun mergeTranscripts(head: String, tail: String): String {
    val h = head.trim()
    val t = tail.trim()
    if (t.isEmpty()) return h
    if (h.isEmpty()) return t
    val hw = wordsOf(h).takeLast(8)
    val tw = wordsOf(t).take(8)
    var overlap = 0
    for (k in minOf(hw.size, tw.size) downTo 1) {
        var same = true
        var i = 0
        while (i < k && same) {
            same = hw[hw.size - k + i].first == tw[i].first
            i++
        }
        // A single shared short word ("the") is more likely coincidence than overlap.
        if (same && (k >= 2 || tw[0].first.length >= 5)) {
            overlap = k
            break
        }
    }
    val rest = if (overlap > 0) t.substring(tw[overlap - 1].second).replace(Regex("^[\\s,;:.!?…-]+"), "") else t
    if (rest.isEmpty()) return h
    return "$h $rest"
}

data class CompleteResult(
    val output: TranscribeOutput,
    /** Extra requests made to recover text the first transcript stopped short of. */
    val resumed: Int,
    /** Seconds of speech the recovery added to the transcript. */
    val recoveredSec: Double,
    val coverage: Coverage
)

/**
 * Transcribe the clip and keep going until the transcript reaches the end of the speech. With
 * timings, only the audio after the point where the transcript stopped is sent again (starting in
 * a pause, without the vocabulary prompt) and appended. Without timings there is nowhere to
 * resume from, so a suspiciously sparse transcript is retried whole without the prompt and the
 * fuller answer wins. Recovery failures are logged and never lose the text already obtained.
 *
 * @param tailPrompt prompt for resumed tails; it must not end with anything the speaker might
 *   say, so it never re-creates the early stop it is recovering from.
 */
suspend fun transcribeComplete(
    pcm: ShortArray,
    sampleRate: Int,
    speechEndSec: Double,
    thresholdDb: Double,
    prompt: String?,
    tailPrompt: String?,
    maxRounds: Int = 3,
    log: (String) -> Unit = {},
    transcribe: suspend (wav: ByteArray, prompt: String?) -> TranscribeOutput
): CompleteResult {
    fun fmt(n: Double): String = String.format(java.util.Locale.ROOT, "%.1f", n)
    var out = transcribe(Wav.encodePcm16(pcm, sampleRate), prompt)
    var resumed = 0
    var recoveredSec = 0.0
    var cov = assessCoverage(out, speechEndSec)
    if (!cov.truncated) return CompleteResult(out, resumed, recoveredSec, cov)

    if (cov.transcribedSec == null) {
        if (prompt != null && prompt != tailPrompt) {
            log("transcript has ${countWords(out.text)} words for ${fmt(speechEndSec)}s of speech and no timings; retrying without the vocabulary prompt")
            try {
                val retry = transcribe(Wav.encodePcm16(pcm, sampleRate), tailPrompt)
                if (countWords(retry.text) > countWords(out.text) * 1.25) {
                    out = retry.copy(latencyMs = out.latencyMs + retry.latencyMs)
                    resumed = 1
                    cov = assessCoverage(out, speechEndSec)
                }
            } catch (e: Exception) {
                log("retry without prompt failed: ${e.message}")
            }
        }
        return CompleteResult(out, resumed, recoveredSec, cov)
    }

    var round = 0
    while (round < maxRounds && cov.truncated && cov.transcribedSec != null) {
        val stoppedAt = cov.transcribedSec!!
        val cut = findCutPoint(pcm, sampleRate, stoppedAt, thresholdDb)
        if (speechEndSec - cut < 0.6 || pcm.size / sampleRate.toDouble() - cut < 0.5) break
        log("transcript stops at ${fmt(stoppedAt)}s of ${fmt(speechEndSec)}s of speech; resuming from ${fmt(cut)}s")
        val tail = try {
            transcribe(Wav.encodePcm16(pcm.copyOfRange((cut * sampleRate).toInt(), pcm.size), sampleRate), tailPrompt)
        } catch (e: Exception) {
            log("resume failed: ${e.message}")
            break
        }
        val tailText = tail.text.trim()
        if (tailText.isEmpty()) break
        val shifted = (tail.spans ?: emptyList()).map { TimedSpan(it.start + cut, it.end + cut) }
        out = out.copy(
            text = mergeTranscripts(out.text, tailText),
            spans = (out.spans ?: emptyList()) + shifted,
            latencyMs = out.latencyMs + tail.latencyMs
        )
        resumed++
        cov = assessCoverage(out, speechEndSec)
        val reached = cov.transcribedSec ?: stoppedAt
        recoveredSec += maxOf(0.0, reached - stoppedAt)
        // The tail came back without timings, or did not move the end: nothing more to learn here.
        if (reached <= stoppedAt + 0.5) break
        round++
    }
    return CompleteResult(out, resumed, recoveredSec, cov)
}
