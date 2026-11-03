package app.murmur.android.dictation

import android.util.Log
import app.murmur.android.audio.Wav
import app.murmur.android.stt.TimedWord
import app.murmur.android.text.Hallucination

private val NOT_WORD = Regex("[^\\p{L}\\p{N}']")
private val SPACES = Regex("\\s+")

/**
 * A transcript that ends with a stock phrase ("...right to me. Thank you.", "...solid week you")
 * whose words, by the model's own timings, sit on audio with no voice in it (a breath, a rustle,
 * the quiet after the last word) loses that phrase. Whisper adds such endings to noise; a speaker
 * who says "thank you" leaves a few hundred ms of pitched sound under it, and keeps it. [words]
 * must be the timings of one answer for exactly [clip] (not resumed or joined). Returns [text],
 * or [text] without the phrase. Mirrors the desktop `dropUnspokenEnding`.
 */
internal fun dropUnspokenEnding(text: String, words: List<TimedWord>?, clip: ShortArray, sampleRate: Int): String {
    if (words.isNullOrEmpty()) return text
    val count = Hallucination.trailingStockPhraseCount(words.map { it.word })
    // The whole transcript being the phrase is the "nothing heard" check's job.
    if (count == 0 || count >= words.size) return text
    // The text must still end with those words (a gateway may have edited the text already):
    // otherwise cutting their count would cut real words.
    fun norm(w: String) = w.lowercase().replace(NOT_WORD, "")
    val tail = text.trim().split(SPACES).takeLast(count).map(::norm)
    if (tail != words.takeLast(count).map { norm(it.word) }) return text
    val pitched = Wav.pitchedMs(clip, sampleRate, words[words.size - count].start - 0.1, words.last().end + 0.1)
    if (pitched >= Hallucination.STOCK_PHRASE_MIN_PITCHED_MS) return text
    val cut = Hallucination.dropLastWords(text, count)
    if (cut.isEmpty() || cut == text) return text
    Log.i("MurmurDictation", "dropped \"${text.substring(cut.length).trim()}\" at the end: no voice under it ($pitched ms pitched)")
    return cut
}
