package app.murmur.android.text

/**
 * Kotlin port of the desktop deterministic cleanup pipeline
 * (apps/desktop/src/core/text/{format,fillers,commands,corrections,pipeline,util}.ts).
 * Fast and predictable; doubles as the fallback whenever the smart-formatting model is
 * slow, unavailable, or returns something suspicious.
 */

// ---- util ------------------------------------------------------------------------------------

private val WORD_RE = Regex("[\\p{L}\\p{N}]+(?:['’][\\p{L}]+)?")

fun countWords(text: String): Int = WORD_RE.findAll(text.trim()).count()

fun capitalizeFirst(s: String): String {
    val idx = s.indexOfFirst { it.isLetter() }
    if (idx < 0) return s
    return s.substring(0, idx) + s[idx].uppercaseChar() + s.substring(idx + 1)
}

fun escapeRegex(s: String): String = Regex.escape(s)

// ---- format ----------------------------------------------------------------------------------

/** Collapse whitespace. Trailing newlines survive (a spoken "new line" at the end is intentional). */
fun normalizeWhitespace(text: String): String = text
    .replace(Regex("\\r\\n?"), "\n")
    .replace(Regex("[ \\t\\u00a0]+"), " ")
    .replace(Regex(" *\\n *"), "\n")
    .replace(Regex("\\n{3,}"), "\n\n")
    .replace(Regex("^\\s+"), "")
    .replace(Regex("[ \\t]+$"), "")

fun fixPunctuationSpacing(text: String): String = text
    .replace(Regex("\\s+([,.!?;:%])"), "$1")
    .replace(Regex("([,;:])(?=[\\p{L}\\p{N}])"), "$1 ")
    .replace(Regex("([.!?])(?=[\\p{Lu}])"), "$1 ")
    .replace(Regex(",{2,}"), ",")
    .replace(Regex("(?<!\\.)\\.{2}(?!\\.)"), ".")
    .replace(Regex("([!?])\\1{2,}"), "$1")
    .replace(Regex(",\\s*([.!?])"), "$1")
    .replace(Regex("\\(\\s+"), "(")
    .replace(Regex("\\s+\\)"), ")")
    .replace(Regex("[ \\t]{2,}"), " ")

private val ABBREVIATION = Regex(
    "(?:^|[\\s(])(?:e\\.g|i\\.e|etc|vs|mr|mrs|ms|dr|st|jr|sr|approx|no|inc|ltd|co|fig|est|dept|p|pp|\\p{L})\\.$",
    RegexOption.IGNORE_CASE
)

fun capitalizeSentences(text: String): String {
    var out = capitalizeFirst(text)
    out = Regex("([.!?]\\s+|\\n\\s*)(\\p{Ll})").replace(out) { m ->
        val sep = m.groupValues[1]
        val ch = m.groupValues[2]
        val before = out.substring(0, m.range.first + 1)
        if (sep.startsWith(".") && ABBREVIATION.containsMatchIn(before)) m.value
        else sep + ch.uppercase()
    }
    // Standalone pronoun "i".
    out = Regex("(^|[\\s(])i(?=[\\s,.!?']|\$)").replace(out) { m -> m.groupValues[1] + "I" }
    return out
}

/**
 * Consecutive dictations should read naturally when inserted back to back, so a
 * sentence that does not already end with whitespace gets one trailing space.
 */
fun applyTrailing(text: String, trailingSpace: Boolean): String {
    if (text.isEmpty() || !trailingSpace) return text
    if (text.last().isWhitespace()) return text
    return "$text "
}

/** Reject obviously broken results (only punctuation / whitespace). */
fun isMeaningful(text: String): Boolean = Regex("[\\p{L}\\p{N}]").containsMatchIn(text)

// ---- fillers ---------------------------------------------------------------------------------

private val OPENERS = Regex(
    "^(?:so|well|okay|ok|yeah|yes|no|right|anyway|also|and|but|first|now|look|alright|sure|oh|hey|hi|hello|thanks|please)$",
    RegexOption.IGNORE_CASE
)
private val GREETING = Regex(
    "\\b(?:hey|hi|hello|dear|thanks|thank you|good (?:morning|afternoon|evening)|yo)\\b",
    RegexOption.IGNORE_CASE
)

val DEFAULT_FILLERS = listOf("um", "uh", "uhm", "umm", "erm", "er", "ah", "hmm", "mm", "mhm", "hm")

/**
 * Remove standalone filler words. Handles the punctuation Whisper wraps around them
 * ("So, um, I think" -> "So, I think") and re-capitalizes when a filler opened a sentence.
 */
fun removeFillers(text: String, fillers: List<String> = DEFAULT_FILLERS): String {
    val list = fillers.map { it.trim() }.filter { it.isNotEmpty() }
    if (list.isEmpty() || text.isEmpty()) return text
    val alternation = list
        .sortedByDescending { it.length }
        .joinToString("|") { escapeRegex(it).replace(Regex("\\s+"), "\\\\s+") }

    // Group 1: leading separator (start, whitespace, or ", "). Group 2: trailing punctuation. Group 3: trailing space.
    val re = Regex(
        "(^|\\s+|,\\s*)(?:$alternation)(?![\\p{L}\\p{N}'’-])([,.!?;:]*)(\\s*)",
        RegexOption.IGNORE_CASE
    )
    val cap = '\u0000'

    var out = re.replace(text) { m ->
        val lead = m.groupValues[1]
        val trail = m.groupValues[2]
        val space = m.groupValues[3]
        val before = text.substring(0, m.range.first)
        val sentenceEnding = Regex("[.!?]").containsMatchIn(trail)
        val atSentenceStart = before.trim().isEmpty() || Regex("[.!?\\n]\\s*$").containsMatchIn(before)

        when {
            atSentenceStart -> {
                // Filler opened the sentence: drop it entirely and capitalize what follows.
                if (sentenceEnding) {
                    if (lead.isEmpty()) "" else lead.replace(Regex(",\\s*$"), " ")
                } else {
                    (if (lead.isEmpty() || lead.last().isWhitespace()) lead else " ") + cap
                }
            }
            lead.trim() == "," -> {
                // "think, um, that" -> "think that" ; "So, uh, can you" -> "So, can you"
                if (sentenceEnding) trail.replace(",", "") + space.ifEmpty { " " }
                else {
                    val clause = lastClause(before)
                    val keepComma = OPENERS.containsMatchIn(clause) ||
                        (GREETING.containsMatchIn(clause) && clause.split(Regex("\\s+")).size <= 4)
                    if (keepComma) ", " else " "
                }
            }
            sentenceEnding -> trail.replace(",", "") + space.ifEmpty { " " }
            else -> if (space.isNotEmpty()) " " else ""
        }
    }

    out = Regex("$cap\\s*([\\s\\S]?)").replace(out) { m -> m.groupValues[1].uppercase() }
    return out
        .replace(Regex("[ \\t]{2,}"), " ")
        .replace(Regex("\\s+([,.!?;:])"), "$1")
        .replace(Regex(",\\s*,"), ",")
        .replace(Regex("(?m)^[ \\t]+|[ \\t]+$"), "")
}

private fun lastClause(before: String): String {
    val parts = before.split(Regex("[.!?\\n]"))
    val sentence = parts.lastOrNull() ?: ""
    return sentence.trim().replace(Regex(",\\s*$"), "").trim()
}

/** "the the" -> "the"; "I I think" -> "I think". Only identical consecutive words. */
fun collapseRepeats(text: String): String =
    Regex("\\b([\\p{L}\\p{N}']+)(?:[ \\t]+\\1\\b)+", RegexOption.IGNORE_CASE).replace(text, "$1")

// ---- spoken commands -------------------------------------------------------------------------

private val ENTER_RE = Regex(
    "(?:^|[\\s,.;:])(?:press|hit)\\s+enter(?:\\s+key)?[.!,\\s]*$|(?:^|[\\s,.;:])(?:and\\s+)?send\\s+it[.!,\\s]*$",
    RegexOption.IGNORE_CASE
)

data class CommandResult(val text: String, val pressEnter: Boolean)

fun extractPressEnter(text: String): CommandResult {
    val m = ENTER_RE.find(text) ?: return CommandResult(text, false)
    val stripped = text.substring(0, m.range.first).replace(Regex("[,\\s]+$"), "")
    return CommandResult(stripped, true)
}

fun applyLineCommands(text: String): String {
    var out = text
    out = Regex("(?:^|,\\s*|\\s+)(?:new\\s?paragraph|paragraph\\s+break)\\b[.,!?;:]*\\s*", RegexOption.IGNORE_CASE)
        .replace(out, "\n\n")
    out = Regex("(?:^|,\\s*|\\s+)(?:new\\s?line|line\\s+break)\\b[.,!?;:]*\\s*", RegexOption.IGNORE_CASE)
        .replace(out, "\n")
    // Capitalize the first word of each new line.
    out = Regex("\\n([ \\t]*)(\\p{Ll})").replace(out) { m ->
        "\n${m.groupValues[1]}${m.groupValues[2].uppercase()}"
    }
    return out
}

fun applyLiteralPunctuation(text: String): String = text
    .replace(Regex("[,.]?\\s*\\bquestion\\s+mark\\b[.,!?]*", RegexOption.IGNORE_CASE), "?")
    .replace(Regex("[,.]?\\s*\\bexclamation\\s+(?:point|mark)\\b[.,!?]*", RegexOption.IGNORE_CASE), "!")
    .replace(Regex("([?!])\\s*([?!])"), "$1")

private val SCRATCH_RE = Regex(
    "(?:^|[,.;:]?\\s*)(?:scratch|delete|strike|undo|erase)\\s+that\\b[.,!?;:]*\\s*",
    RegexOption.IGNORE_CASE
)
private val LEAD_IN_WORDS = setOf(
    "actually", "no", "wait", "sorry", "um", "uh", "hmm", "oh", "ok", "okay",
    "never", "mind", "nevermind", "and"
)

/**
 * "Send it tomorrow. Actually, scratch that. Send it today." -> "Send it today."
 * Deletes back to the previous sentence boundary; lead-in-only fragments pull in
 * the previous sentence too.
 */
fun applyScratchThat(text: String): String {
    var out = text
    var guard = 0
    while (guard++ < 20) {
        val m = SCRATCH_RE.find(out) ?: break
        val cmdStart = m.range.first
        val cmdEnd = m.range.last + 1
        val before = out.substring(0, cmdStart)
        var cut = lastSentenceBoundary(before)
        val partial = before.substring(cut).trim()
        val partialWords = partial.split(Regex("\\s+"))
            .map { it.replace(Regex("[^\\p{L}\\p{N}']"), "").lowercase() }
            .filter { it.isNotEmpty() }
        if (partialWords.isEmpty() ||
            (partialWords.size <= 2 && partialWords.all { it in LEAD_IN_WORDS })
        ) {
            cut = lastSentenceBoundary(before.substring(0, cut).replace(Regex("[.!?\\s]+$"), ""))
        }
        val head = out.substring(0, cut).trimEnd()
        var tail = out.substring(cmdEnd).trimStart()
        if (tail.isNotEmpty()) tail = tail[0].uppercaseChar() + tail.substring(1)
        out = if (head.isNotEmpty()) {
            if (tail.isNotEmpty()) "$head $tail" else head
        } else tail
    }
    return out
}

private fun lastSentenceBoundary(s: String): Int {
    val m = Regex("[.!?\\n](?=\\s|$)(?![\\s\\S]*[.!?\\n](?=\\s|$))").find(s) ?: return 0
    return m.range.first + 1
}

// ---- self-corrections ------------------------------------------------------------------------

private val CORRECTION_MARKERS = listOf(
    "no wait", "wait no", "no", "i mean", "sorry", "or rather", "rather",
    "correction", "make that", "scratch that"
)
private val STOP_WORDS = setOf(
    "and", "but", "or", "then", "so", "because", "with", "at", "on", "in",
    "to", "for", "of", "by", "from"
)
private val MARKER_RE = Regex(
    ",\\s*(?:${CORRECTION_MARKERS.joinToString("|") { it.replace(" ", "\\s+") }})\\s*,\\s*",
    RegexOption.IGNORE_CASE
)
private val NUMERIC = Regex("^[$€£]?\\d[\\d,.:]*(?:%|am|pm|k|x)?$", RegexOption.IGNORE_CASE)

private data class Tok(val text: String, val start: Int, val end: Int)

/**
 * "let's meet on Tuesday, no, Wednesday at 5" -> "let's meet on Wednesday at 5".
 * Conservative: the marker must be wrapped in commas (how Whisper transcribes the pause)
 * and the replacement is bounded by punctuation/conjunctions.
 */
fun applySelfCorrections(text: String): String {
    var out = text
    var guard = 0
    while (guard++ < 10) {
        val m = MARKER_RE.find(out) ?: break
        val before = out.substring(0, m.range.first)
        val after = out.substring(m.range.last + 1)

        val afterAll = leadingTokens(after, 6)
        val beforeAll = trailingTokensInSentence(before, 6)
        if (afterAll.isEmpty() || beforeAll.isEmpty()) {
            out = "${before.trimEnd()} $after"
            continue
        }

        val beforeSpan: List<Tok>
        val replacement: List<Tok>

        val anchor = findAnchor(beforeAll, afterAll[0])
        if (anchor >= 0 && beforeAll.size - anchor <= afterAll.size) {
            val n = beforeAll.size - anchor
            beforeSpan = beforeAll.subList(anchor, beforeAll.size)
            replacement = afterAll.subList(0, n)
        } else if (NUMERIC.matches(afterAll[0].text) && lastNumericIndex(beforeAll) >= 0) {
            val idx = lastNumericIndex(beforeAll)
            beforeSpan = listOf(beforeAll[idx])
            replacement = listOf(afterAll[0])
        } else {
            val run = boundedRun(afterAll)
            val n = minOf(run.size, beforeAll.size)
            beforeSpan = beforeAll.subList(beforeAll.size - n, beforeAll.size)
            replacement = run.subList(0, n)
        }

        val head = before.substring(0, beforeSpan[0].start)
        val tail = after.substring(replacement.last().end)
        var replacementText = after.substring(replacement[0].start, replacement.last().end)
        if (Regex("^\\s*$").matches(head) || Regex("[.!?]\\s*$").containsMatchIn(head)) {
            replacementText = capitalizeFirst(replacementText)
        }
        out = "$head$replacementText$tail"
    }
    return out
}

private fun leadingTokens(s: String, max: Int): List<Tok> {
    val re = Regex("[\\p{L}\\p{N}'’$€£%#@:-]+|[.,;!?\\n]")
    val out = ArrayList<Tok>()
    for (m in re.findAll(s)) {
        if (out.size >= max) break
        val t = m.value
        if (Regex("^[.,;!?\\n]$").matches(t)) break
        out.add(Tok(t, m.range.first, m.range.last + 1))
    }
    return out
}

private fun trailingTokensInSentence(s: String, max: Int): List<Tok> {
    val boundaryMatch = Regex("[.!?\\n](?=[^.!?\\n]*$)").find(s)
    val startAt = if (boundaryMatch != null) boundaryMatch.range.first + 1 else 0
    val re = Regex("[\\p{L}\\p{N}'’$€£%#@:-]+")
    val all = ArrayList<Tok>()
    for (m in re.findAll(s.substring(startAt))) {
        all.add(Tok(m.value, startAt + m.range.first, startAt + m.range.last + 1))
    }
    return if (all.size <= max) all else all.subList(all.size - max, all.size)
}

private fun findAnchor(before: List<Tok>, first: Tok): Int {
    val target = first.text.lowercase()
    if (target in STOP_WORDS) return -1
    for (i in before.size - 1 downTo maxOf(0, before.size - 4)) {
        if (before[i].text.lowercase() == target) return i
    }
    return -1
}

private fun lastNumericIndex(before: List<Tok>): Int {
    for (i in before.size - 1 downTo maxOf(0, before.size - 3)) {
        if (NUMERIC.matches(before[i].text)) return i
    }
    return -1
}

/** First run of words (max 3) that stops at a conjunction/preposition after the first word. */
private fun boundedRun(tokens: List<Tok>): List<Tok> {
    val out = ArrayList<Tok>()
    for (t in tokens) {
        if (out.isNotEmpty() && t.text.lowercase() in STOP_WORDS) break
        out.add(t)
        if (out.size == 3) break
    }
    return out
}

// ---- pipeline --------------------------------------------------------------------------------

data class PipelineOptions(
    val removeFillers: Boolean = true,
    val fillerWords: List<String> = DEFAULT_FILLERS,
    val collapseRepeats: Boolean = true,
    val spokenCommands: Boolean = true,
    val selfCorrections: Boolean = true,
    val autoCapitalize: Boolean = true,
    val trailingSpace: Boolean = true,
    val pressEnterCommand: Boolean = true
)

data class PipelineResult(
    val text: String,
    val pressEnter: Boolean,
    val wordCount: Int,
    val stages: List<String>,
    val empty: Boolean
)

/** Deterministic cleanup that runs on every dictation, with or without the LLM stage. */
fun runPipeline(raw: String, opts: PipelineOptions): PipelineResult {
    val stages = ArrayList<String>()
    var text = normalizeWhitespace(raw)
    var pressEnter = false

    fun step(name: String, fn: (String) -> String) {
        val next = fn(text)
        if (next != text) stages.add(name)
        text = next
    }

    if (opts.spokenCommands) {
        if (opts.pressEnterCommand) {
            val r = extractPressEnter(text)
            if (r.pressEnter) {
                stages.add("press-enter")
                pressEnter = true
                text = r.text
            }
        }
        step("scratch-that", ::applyScratchThat)
        step("line-commands", ::applyLineCommands)
        step("literal-punctuation", ::applyLiteralPunctuation)
    }
    if (opts.removeFillers) step("fillers") { removeFillers(it, opts.fillerWords) }
    if (opts.collapseRepeats) step("repeats", ::collapseRepeats)
    if (opts.selfCorrections) step("self-corrections", ::applySelfCorrections)
    step("punctuation", ::fixPunctuationSpacing)
    if (opts.autoCapitalize) step("capitalize", ::capitalizeSentences)
    text = normalizeWhitespace(text)

    val empty = !isMeaningful(text)
    if (!empty) text = applyTrailing(text, opts.trailingSpace && !text.endsWith("\n"))

    return PipelineResult(
        text = if (empty) "" else text,
        pressEnter = pressEnter,
        wordCount = countWords(text),
        stages = stages,
        empty = empty
    )
}

/** Second pass after the LLM: re-assert layout rules only. */
fun finalizeAfterLlm(llmText: String, opts: PipelineOptions): PipelineResult {
    var text = normalizeWhitespace(llmText)
    text = fixPunctuationSpacing(text)
    val empty = !isMeaningful(text)
    if (!empty) text = applyTrailing(text, opts.trailingSpace && !text.endsWith("\n"))
    return PipelineResult(
        text = if (empty) "" else text,
        pressEnter = false,
        wordCount = countWords(text),
        stages = listOf("llm"),
        empty = empty
    )
}
