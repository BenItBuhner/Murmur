package app.murmur.android.text

/**
 * Whisper-family models read the prompt as the transcript of the audio before the clip, and can
 * answer a clip with no speech in it (noise, the phone being handled, the tap that stops the
 * dictation) with the prompt itself: Oct 29 2026, "…major, major, major. Dictation with
 * punctuation." A sentence that is nothing but a run of the prompt's words, and that cannot be the
 * speaker (it holds the style hint's "punctuation" or opens with "Vocabulary"), is dropped.
 * Mirrors packages/text-engine/src/prompt-echo.ts.
 */
object PromptEcho {
    private val WORD = Regex("""[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*""")
    private val SENTENCE = Regex("""[^.!?…]*[.!?…]+["')\]]*\s*|[^.!?…]+$""")
    private val ANY_WORD = Regex("""[\p{L}\p{N}]""")

    private fun wordsOf(s: String): List<String> =
        WORD.findAll(s).map { it.value.lowercase().replace('’', '\'') }.toList()

    private fun isRunOf(words: List<String>, run: List<String>): Boolean {
        if (run.isEmpty() || run.size > words.size) return false
        for (i in 0..words.size - run.size) if ((run.indices).all { words[i + it] == run[it] }) return true
        return false
    }

    /** One sentence of a transcript is the prompt read back. */
    fun isEcho(sentence: String, prompt: String?): Boolean {
        if (prompt.isNullOrEmpty()) return false
        val s = wordsOf(sentence)
        if (s.size < 2) return false
        if ("punctuation" !in s && s[0] != "vocabulary") return false
        return isRunOf(wordsOf(prompt), s)
    }

    /**
     * The transcript without sentences that are the prompt read back, and without a lone mark the
     * model gives for silence ("."). The same string when there is nothing to drop.
     */
    fun strip(text: String, prompt: String?): String {
        if (text.isEmpty()) return text
        if (!ANY_WORD.containsMatchIn(text)) return if (text.isNotBlank()) "" else text
        if (prompt.isNullOrEmpty()) return text
        val sentences = SENTENCE.findAll(text).map { it.value }.toList().ifEmpty { listOf(text) }
        val keep = sentences.filterNot { isEcho(it, prompt) }
        if (keep.size == sentences.size) return text
        return keep.joinToString("").trim()
    }
}
