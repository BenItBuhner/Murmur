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
}
