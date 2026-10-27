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

        // Content said twice that the speaker said once (a looping or padding model).
        if (repeatedRuns(raw, text, 4).isNotEmpty()) return Verdict(false, "repeated")

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

    // ---- repetition and layout (mirrors verify.ts) -------------------------------------------

    private val RUN_STRIP = Regex("[^\\p{L}\\p{N}' ]+")
    private fun runWords(s: String): List<String> =
        RUN_STRIP.replace(s.lowercase(), " ").split(Regex("\\s+")).filter { it.isNotEmpty() }

    private fun runCounts(w: List<String>, n: Int): Map<String, Int> {
        val m = HashMap<String, Int>()
        for (i in 0..(w.size - n)) {
            if (i < 0) break
            val k = w.subList(i, i + n).joinToString(" ")
            m[k] = (m[k] ?: 0) + 1
        }
        return m
    }

    /** Word runs the answer repeats more often than the transcript did (see verify.ts). */
    fun repeatedRuns(transcript: String, text: String, n: Int = 3): List<String> {
        val a = runWords(transcript)
        val b = runWords(text)
        val out = ArrayList<String>()
        val inA = if (a.size >= n) runCounts(a, n) else emptyMap()
        if (b.size >= n) for ((k, v) in runCounts(b, n)) if (v >= 2 && v > (inA[k] ?: 0)) out.add(k)
        val doubledInA = HashSet<String>()
        for (i in 1 until a.size) if (a[i] == a[i - 1]) doubledInA.add(a[i])
        for (i in 1 until b.size) if (b[i] == b[i - 1] && b[i].length > 2 && b[i] !in doubledInA) out.add("${b[i]} ${b[i]}")
        return out
    }

    private val LAYOUT_CUE = Regex(
        "\\n|\\b(?:new|next) (?:line|paragraph)\\b|\\b(?:bullet|number) (?:one|two|1|2)\\b|\\b(?:first(?:ly)?|second(?:ly)?)\\b[\\s\\S]*\\b(?:second(?:ly)?|third(?:ly)?|finally|lastly)\\b|:\\s*\\S",
        RegexOption.IGNORE_CASE
    )
    private val LIST_LINE = Regex("^\\s*(?:[-*•]|\\d{1,2}[.)])\\s+", RegexOption.MULTILINE)
    private val DOUBLED_RUN = Regex(
        "(?<![\\p{L}\\p{N}])((?:[\\p{L}\\p{N}][\\p{L}\\p{N}'’.@/-]*[\\s,]+){0,5}[\\p{L}\\p{N}][\\p{L}\\p{N}'’.@/-]*)(?:[\\s,.;]+\\1)+(?![\\p{L}\\p{N}])",
        RegexOption.IGNORE_CASE
    )

    /** Repairs that cost no round trip, applied before the invariants (see verify.ts). */
    fun repairOutput(transcript: String, text: String): String {
        val inInput = runWords(transcript).joinToString(" ")
        var out = DOUBLED_RUN.replace(text) { m ->
            val run = m.groupValues[1]
            if (Regex("\\d").containsMatchIn(run)) return@replace m.value
            val key = runWords(run).joinToString(" ")
            if (inInput.contains("$key $key")) m.value else run
        }
        if (out.contains('\n') && !LAYOUT_CUE.containsMatchIn(transcript) && !LIST_LINE.containsMatchIn(out))
            out = out.replace(Regex("[ \\t]*\\n+[ \\t]*"), " ")
        return out.trim()
    }

    private val LOWER_I = Regex("(?<![\\p{L}\\p{N}'’._@/\\\\-])i(?=(?:['’](?:m|ll|ve|d))?(?![\\p{L}\\p{N}'’_@/\\\\-])(?!\\.\\p{L}))")
    private val SENTENCE_LOWER = Regex("([.!?][\"')\\]]*\\s+)(\\p{Ll}[\\p{L}\\p{N}'’-]*)")
    private val LOWER_INSTRUCTION = Regex("lower[\\s-]?case|no capital", RegexOption.IGNORE_CASE)

    /**
     * Capitals the model dropped: the pronoun "I" and a lower-case word right after a sentence end,
     * unless the transcript wrote them that way, the word is mixed-case, or the period ends an
     * abbreviation or an ellipsis. The first word is left alone. Not in code, a terminal, or when
     * the instructions ask for lower case. Mirrors repairCase in verify.ts.
     */
    fun repairCase(transcript: String, text: String, category: AppCategory, instructions: String?): String {
        if (category == AppCategory.CODE || category == AppCategory.TERMINAL) return text
        if (instructions != null && LOWER_INSTRUCTION.containsMatchIn(instructions)) return text
        var out = text
        if (!LOWER_I.containsMatchIn(transcript)) out = LOWER_I.replace(out, "I")
        val whole = out
        out = SENTENCE_LOWER.replace(whole) { m ->
            val sep = m.groupValues[1]
            val word = m.groupValues[2]
            if (word.any { it.isUpperCase() }) return@replace m.value
            val before = whole.substring(0, m.range.first + 1)
            if (sep.startsWith(".") && (ABBREVIATION.containsMatchIn(before) || before.endsWith("..") || Regex("\\.\\p{L}+\\.$").containsMatchIn(before)))
                return@replace m.value
            if (transcript.contains("${sep.trim()} $word")) return@replace m.value
            sep + word.substring(0, 1).uppercase() + word.substring(1)
        }
        return out
    }
}
