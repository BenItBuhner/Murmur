package app.murmur.android.text

/**
 * Whisper-family models answer a clip with no speech in it (a quiet tail, a breath, a click) with
 * the closing lines of videos: "Thank you.", "Thanks for watching!", "you". Mirrors
 * packages/text-engine/src/hallucination.ts; the caller decides when the audio was quiet enough.
 */
object Hallucination {
    private val PHRASES = listOf(
        "thank you", "thank you very much", "thank you so much", "thanks", "thanks for watching",
        "thank you for watching", "thanks for listening", "thank you for listening",
        "thank you for watching and see you next time", "please subscribe", "like and subscribe",
        "subscribe to my channel", "subtitles by the amara org community", "transcribed by",
        "you", "bye", "bye bye", "okay", "so", "uh", "um", "hmm",
        // Oct 29 2026: the production models' answer to a second of silence with a vocabulary prompt.
        "the end"
    )
    private val KNOWN = PHRASES.toHashSet()
    private val STRIP = Regex("[^\\p{L}\\p{N}' ]+")
    private val SPACES = Regex("\\s+")

    fun normalize(text: String): String = SPACES.replace(STRIP.replace(text.lowercase(), " "), " ").trim()

    /** The whole text is one of the phrases a model says to silence (repeats included). */
    fun isSilencePhrase(text: String): Boolean {
        val n = normalize(text)
        if (n.isEmpty()) return false
        if (n in KNOWN) return true
        val words = n.split(' ')
        for (p in PHRASES) {
            val pw = p.split(' ')
            if (words.size % pw.size != 0) continue
            if (words.chunked(pw.size).all { it == pw }) return true
        }
        return false
    }

    /**
     * Voiced time below which a text that reads as a stock phrase is taken for silence. A real
     * "thank you" is ~400 ms voiced, so this only fires on (near-)silence: audio evidence, never text.
     */
    const val MIN_SPEECH_MS = 120
    /** Frame level counted as voiced for that check; VOICE_RECOGNITION has no AGC, so speech is quiet. */
    const val VOICED_DB = -50.0

    private const val LOOP_MIN_WORDS = 3
    private const val LOOP_MAX_WORDS = 12
    private const val LOOP_MIN_COPIES = 3
    private val WORD = Regex("\\S+")
    private val NOT_WORD_CHAR = Regex("[^\\p{L}\\p{N}']")

    private class Tok(val start: Int, val end: Int, val key: String)

    /**
     * A run of 3 to 12 words the speech model wrote 3 or more times back to back keeps its first
     * copy (a stuck recognizer); runs of numbers only are left alone. Mirrors `collapseLoops`.
     */
    fun collapseLoops(text: String): String {
        val words = WORD.findAll(text).map {
            Tok(it.range.first, it.range.last + 1, it.value.lowercase().replace(NOT_WORD_CHAR, ""))
        }.toList()
        if (words.size < LOOP_MIN_WORDS * LOOP_MIN_COPIES) return text
        val out = StringBuilder()
        var from = 0
        var i = 0
        while (i < words.size) {
            var foundK = 0
            var foundCopies = 0
            var k = LOOP_MIN_WORDS
            while (k <= LOOP_MAX_WORDS && i + k * LOOP_MIN_COPIES <= words.size) {
                val unit = words.subList(i, i + k)
                if (unit.any { it.key.isEmpty() } ||
                    unit.all { NumberSignature.isNumberWord(it.key) || it.key[0].isDigit() }
                ) {
                    k++
                    continue
                }
                var copies = 1
                while (i + (copies + 1) * k <= words.size &&
                    unit.indices.all { j -> words[i + copies * k + j].key == unit[j].key }
                ) copies++
                if (copies >= LOOP_MIN_COPIES) {
                    foundK = k
                    foundCopies = copies
                    break
                }
                k++
            }
            if (foundK == 0) {
                i++
                continue
            }
            out.append(text, from, words[i + foundK - 1].end)
            val next = i + foundK * foundCopies
            from = if (next < words.size) words[next].start else text.length
            if (next < words.size) out.append(' ')
            i = next
        }
        return out.append(text.substring(from)).toString()
    }
}
