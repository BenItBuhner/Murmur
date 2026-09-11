package app.murmur.android.text

/**
 * Port of packages/text-engine/src/verify.ts: clean the model's answer of the wrapping models add,
 * then check the invariants that can be decided without understanding the text (not empty, not
 * chatty, not an answer, roughly the same length, mostly the same content words, exactly the same
 * numbers in the same order). Pinned to the TypeScript engine by GoldenEngineTest.
 */
object Verify {
    private val THINK_BLOCK = Regex("<(think|thinking|reasoning|analysis|scratchpad)>[\\s\\S]*?</\\1>\\s*", RegexOption.IGNORE_CASE)
    private val UNTERMINATED_THINK = Regex("^<(?:think|thinking|reasoning|analysis|scratchpad)>[\\s\\S]*$", RegexOption.IGNORE_CASE)
    private val LABEL_PREFIX = Regex(
        "^(?:(?:here(?:'s| is) |this is )?(?:the |your |my )?(?:cleaned(?:[- ]up)?|formatted|polished|final|corrected|edited|revised|fixed|rewritten|improved)(?: up)?(?: text| version| transcript| dictation| sentence| output)?|output|result|text|transcript|answer|response)\\s*:\\s*\\n?",
        RegexOption.IGNORE_CASE
    )
    private val COMMENTARY_LINE = Regex(
        "^(?:let me know|hope (?:this|that) helps|i(?:'ve| have)? (?:cleaned|removed|fixed|corrected|kept|changed|also|made|applied)|note:|notes:|changes(?: made)?:|i removed|i corrected|i changed|here(?:'s| is) (?:the|your|a)|this (?:version|text|keeps|removes)|the (?:cleaned|corrected|revised) (?:text|version)|\\(?(?:no|nothing) (?:changes?|to (?:change|clean))|feel free)",
        RegexOption.IGNORE_CASE
    )
    private val FENCE = Regex("^```[a-z]*\\n?([\\s\\S]*?)\\n?```$", RegexOption.IGNORE_CASE)
    private val TRANSCRIPT_TAG = Regex("^</?transcript>\\s*|\\s*</?transcript>$", RegexOption.IGNORE_CASE)
    private val WRAPPING_QUOTES = Regex("^[\"“”'‘’][\\s\\S]*[\"“”'‘’]$")
    private val OPENING_QUOTE = Regex("^[\"“”'‘’]")
    private val HEADING = Regex("^#{1,6}\\s+", RegexOption.MULTILINE)
    private val BOLD = Regex("\\*\\*([^*\\n]+)\\*\\*")
    private val UNDERLINE = Regex("__([^_\\n]+)__")
    private val CODE = Regex("`([^`\\n]+)`")

    fun cleanModelOutput(output: String, transcript: String): String {
        var text = output.replace(Regex("\\r\\n?"), "\n")
        text = THINK_BLOCK.replace(text, "")
        if (UNTERMINATED_THINK.matches(text.trim())) return ""
        text = text.trim()
        FENCE.find(text)?.let { text = it.groupValues[1].trim() }
        text = TRANSCRIPT_TAG.replace(text, "")
        text = LABEL_PREFIX.replace(text, "").trim()
        if (WRAPPING_QUOTES.matches(text) && !OPENING_QUOTE.containsMatchIn(transcript.trim())) {
            text = text.substring(1, text.length - 1).trim()
        }
        text = HEADING.replace(text, "")
        text = BOLD.replace(text, "$1")
        text = UNDERLINE.replace(text, "$1")
        if (!transcript.contains('`')) text = CODE.replace(text, "$1")
        val lines = text.split("\n").toMutableList()
        while (lines.size > 1 && (COMMENTARY_LINE.containsMatchIn(lines.last().trim()) || lines.last().isBlank())) {
            lines.removeAt(lines.size - 1)
        }
        if (lines.size > 2 && COMMENTARY_LINE.containsMatchIn(lines[0].trim()) && lines[1].isBlank()) {
            lines.removeAt(0)
            lines.removeAt(0)
        }
        text = lines.joinToString("\n").trim()
        // A fence that was followed by commentary only closes once the commentary is gone.
        FENCE.find(text)?.let { text = it.groupValues[1].trim() }
        return LABEL_PREFIX.replace(text, "").trim()
    }

    private val CHATTY_PREFIX = Regex(
        "^(?:sure|certainly|of course|absolutely|here(?:'s| is| are)|i(?:'m| am) sorry|as an ai|i can(?:'t|not)|the cleaned|cleaned text|here you go|i'd be happy|i (?:have|'ve) (?:cleaned|removed)|okay,? here)\\b",
        RegexOption.IGNORE_CASE
    )
    private val PROMPT_ECHO = Regex(
        "\\b(?:you clean up voice dictation|speech recognizer transcribed|^destination:|^transcript:|^keep verbatim:|^before the cursor:)",
        setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE)
    )
    private val CONTENT_WORD = Regex("\\p{L}+(?:['’]\\p{L}+)?")
    private val SENTENCE_SPLIT = Regex("(?<=[.!?])\\s+")

    data class Verdict(val ok: Boolean, val reason: String? = null, val expected: String? = null, val actual: String? = null)

    private fun contentWords(s: String): Set<String> {
        val out = HashSet<String>()
        for (m in CONTENT_WORD.findAll(s.lowercase())) {
            val w = m.value
            if (w.length >= 3 && !NumberSignature.isNumberWord(w)) out.add(w.trim('\'', '’'))
        }
        return out
    }

    /** `text` is the cleaned model output; `transcript` is what the model was given. */
    fun verifyOutput(
        transcript: String,
        text: String,
        allowEmpty: Boolean = false,
        language: String? = null,
        keepVerbatim: List<String> = emptyList()
    ): Verdict {
        val raw = transcript.trim()
        if (text.isBlank()) return if (allowEmpty) Verdict(true) else Verdict(false, "empty")
        if (CHATTY_PREFIX.containsMatchIn(text) && !CHATTY_PREFIX.containsMatchIn(raw)) return Verdict(false, "chatty")
        if (PROMPT_ECHO.containsMatchIn(text) && !PROMPT_ECHO.containsMatchIn(raw)) return Verdict(false, "echo")

        val rawUnits = NumberSignature.countUnits(raw)
        val outUnits = NumberSignature.countUnits(text)
        if (rawUnits >= 6) {
            val ratio = outUnits.toDouble() / rawUnits
            if (ratio < 0.3) return Verdict(false, "too-short")
            if (ratio > 2.2) return Verdict(false, "too-long")
        } else if (outUnits > rawUnits + 6) {
            return Verdict(false, "too-long")
        }

        if (isQuestion(raw) && countWords(raw) >= 3 && !text.contains('?')) {
            val firstOut = text.split(SENTENCE_SPLIT).firstOrNull() ?: text
            if (!QUESTION_START.containsMatchIn(firstOut)) return Verdict(false, "answered")
        }

        val rawSet = contentWords(raw)
        val outSet = contentWords(text)
        if (rawSet.size >= 4 && outSet.size >= 3) {
            var shared = 0
            for (w in outSet) if (w in rawSet) shared++
            if (shared.toDouble() / outSet.size < 0.45) return Verdict(false, "diverged")
        }

        for (phrase in keepVerbatim) {
            val p = phrase.trim().lowercase()
            if (p.isNotEmpty() && raw.lowercase().contains(p) && !text.lowercase().contains(p)) {
                return Verdict(false, "verbatim-lost", phrase)
            }
        }

        val expected = NumberSignature.digitSignature(raw)
        val withoutMarkers = NumberSignature.digitSignature(text, true)
        val withMarkers = NumberSignature.digitSignature(text, false)
        val lang = (language ?: "auto").trim().lowercase().split('-', '_')[0]
        if (lang.isNotEmpty() && lang != "auto" && lang != "en") {
            if (!withoutMarkers.contains(expected) && !withMarkers.contains(expected)) {
                return Verdict(false, "numbers-changed", expected, withoutMarkers)
            }
            return Verdict(true)
        }
        if (withoutMarkers != expected && withMarkers != expected) return Verdict(false, "numbers-changed", expected, withoutMarkers)
        return Verdict(true)
    }
}
