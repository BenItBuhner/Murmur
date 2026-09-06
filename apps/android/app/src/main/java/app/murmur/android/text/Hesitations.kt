package app.murmur.android.text

import app.murmur.android.settings.HesitationLevel

/**
 * Kotlin port of apps/desktop/src/core/text/hesitations.ts: multi-word verbal tics that the
 * recognizer transcribes faithfully but nobody wants typed. A phrase is only removed where the
 * transcript marks it as a pause (sentence start, wrapped in commas, before punctuation) and
 * never after a word that makes it part of the sentence ("do you know", "I like").
 */

data class HesitationEntry(
    val phrase: String,
    val notAfter: Set<String> = emptySet(),
    val requireComma: Boolean = false,
    val notAtStart: Boolean = false,
    val commaAtStart: Boolean = false
)

private val VERB_SUBJECTS = setOf(
    "i", "you", "we", "they", "he", "she", "it", "people", "who", "that", "which", "to", "not",
    "do", "does", "did", "don't", "doesn't", "didn't", "would", "wouldn't", "really", "also", "still",
    "just", "much", "more", "something", "anything", "nothing", "things", "is", "was", "are", "were",
    "be", "been", "being", "am", "i'm", "it's", "that's", "what's", "he's", "she's", "they're", "we're",
    "you're", "feel", "feels", "felt", "look", "looks", "looked", "sound", "sounds", "sounded", "seem",
    "seems", "seemed", "taste", "tastes", "smell", "smells"
)

private val KNOW_CONTEXT = setOf(
    "do", "did", "does", "don't", "didn't", "doesn't", "if", "whether", "than", "as", "let", "that",
    "what", "how", "why", "when", "where", "to", "would", "will", "should", "could", "can"
)

val LIGHT_HESITATIONS: List<HesitationEntry> = listOf(
    HesitationEntry("you know what i mean"),
    HesitationEntry("if you know what i mean"),
    HesitationEntry("you know", notAfter = KNOW_CONTEXT, commaAtStart = true),
    HesitationEntry("i mean", notAfter = setOf("what", "do", "did", "you", "they", "we"), commaAtStart = true),
    HesitationEntry("like", notAfter = VERB_SUBJECTS, requireComma = true),
    HesitationEntry("let me think"),
    HesitationEntry("let me see"),
    HesitationEntry("let's see"),
    HesitationEntry("hold on"),
    HesitationEntry("hang on"),
    HesitationEntry("what's the word"),
    HesitationEntry("what was it"),
    HesitationEntry("what is it called"),
    HesitationEntry("what's it called"),
    HesitationEntry("how do i put this"),
    HesitationEntry("how do i say this"),
    HesitationEntry("how do you say"),
    HesitationEntry("how should i put it"),
    HesitationEntry("where was i"),
    HesitationEntry("if that makes sense"),
    HesitationEntry("does that make sense"),
    HesitationEntry("so yeah"),
    HesitationEntry("yeah so"),
    HesitationEntry("okay so"),
    HesitationEntry("ok so"),
    HesitationEntry("alright so"),
    HesitationEntry("and stuff like that"),
    HesitationEntry("and things like that"),
    HesitationEntry("or something like that"),
    HesitationEntry("and so on and so forth")
)

val THOROUGH_HESITATIONS: List<HesitationEntry> = listOf(
    HesitationEntry("sort of", requireComma = true, notAfter = setOf("a", "the", "this", "that", "some", "what")),
    HesitationEntry("kind of", requireComma = true, notAfter = setOf("a", "the", "this", "that", "some", "what")),
    HesitationEntry("kinda", requireComma = true),
    HesitationEntry("sorta", requireComma = true),
    HesitationEntry("basically", requireComma = true),
    HesitationEntry("actually", requireComma = true),
    HesitationEntry("literally", requireComma = true),
    HesitationEntry("honestly", requireComma = true),
    HesitationEntry("to be honest", requireComma = true),
    HesitationEntry("i guess", requireComma = true),
    HesitationEntry("i suppose", requireComma = true),
    HesitationEntry("or whatever"),
    HesitationEntry("or something"),
    HesitationEntry("and stuff"),
    HesitationEntry("and whatnot"),
    HesitationEntry("and everything", requireComma = true),
    HesitationEntry("at the end of the day", requireComma = true),
    HesitationEntry("yeah", requireComma = true, notAtStart = true),
    HesitationEntry(
        "right", requireComma = true, notAtStart = true,
        notAfter = setOf("the", "a", "all", "is", "was", "that's", "you're", "it's", "not", "turn", "to", "on", "my", "your", "be")
    ),
    HesitationEntry("anyway"),
    HesitationEntry("anyways")
)

private val OPENER_CHAIN = Regex(
    "(^|[.!?]\\s+|\\n\\s*)(?:(?:okay|ok|alright|all right|yeah|yep|right|well|um|uh|and|so)[,.]?\\s+)*" +
        "(?:so|anyway|anyways|well|alright|all right)[,.]\\s*(?:(?:um|uh)[,.]?\\s+)*(?=\\S)",
    RegexOption.IGNORE_CASE
)
private val LIGHT_TAIL = Regex("(?<=\\S)\\s+(?:and|but|or|because|and then|so that|which)[,.\\s…-]*$", RegexOption.IGNORE_CASE)
private val THOROUGH_TAIL = Regex(
    "(?<=\\S)\\s+(?:and|but|or|because|and then|so that|which|so|yeah|so yeah|okay|ok)[,.\\s…-]*$",
    RegexOption.IGNORE_CASE
)
private const val CAP = '\u0000'

fun hesitationEntries(level: HesitationLevel, custom: List<String> = emptyList()): List<HesitationEntry> {
    if (level == HesitationLevel.OFF) return emptyList()
    val base = if (level == HesitationLevel.THOROUGH) LIGHT_HESITATIONS + THOROUGH_HESITATIONS else LIGHT_HESITATIONS
    val seen = base.map { it.phrase }.toMutableSet()
    val extra = custom.map { it.trim().lowercase() }.filter { it.isNotEmpty() && seen.add(it) }.map { HesitationEntry(it) }
    return base + extra
}

/** Every single word that may vanish as hesitation. */
fun hesitationWords(level: HesitationLevel, custom: List<String> = emptyList()): Set<String> =
    hesitationEntries(level, custom).flatMap { it.phrase.split(Regex("\\s+")) }.toSet()

private fun compile(entries: List<HesitationEntry>): Regex {
    val alternation = entries.map { it.phrase.trim().lowercase() }
        .filter { it.isNotEmpty() }
        .sortedByDescending { it.length }
        .joinToString("|") { p -> p.split(Regex("\\s+")).joinToString("\\s+") { Regex.escape(it).replace("'", "['’]") } }
    return Regex(
        "(^|[.!?]\\s+|\\n\\s*|,\\s*|\\s+)($alternation)(?![\\p{L}\\p{N}'’-])(\\s*[,.!?;:—–-]*)(\\s*)",
        RegexOption.IGNORE_CASE
    )
}

private fun lastWord(s: String): String {
    val m = Regex("([\\p{L}\\p{N}'’]+)[^\\p{L}\\p{N}]*$").find(s) ?: return ""
    return m.groupValues[1].lowercase().replace('’', '\'')
}

fun removeHesitations(text: String, level: HesitationLevel, custom: List<String> = emptyList()): String {
    if (level == HesitationLevel.OFF || text.isEmpty()) return text
    val entries = hesitationEntries(level, custom)
    val byPhrase = entries.associateBy { it.phrase.replace(Regex("\\s+"), " ") }
    val re = compile(entries)
    val thorough = level == HesitationLevel.THOROUGH

    var out = text
    for (pass in 0 until 2) {
        val before = out
        val whole = out
        out = re.replace(out) { m ->
            val lead = m.groupValues[1]
            val phrase = m.groupValues[2]
            val trail = m.groupValues[3]
            val space = m.groupValues[4]
            val key = phrase.lowercase().replace('’', '\'').replace(Regex("\\s+"), " ")
            val entry = byPhrase[key] ?: return@replace m.value
            val prefix = whole.substring(0, m.range.first)
            val atStart = lead.isEmpty() || Regex("^[.!?]\\s+$").matches(lead) || Regex("^\\n\\s*$").matches(lead)
            val commaBefore = Regex("^,\\s*$").matches(lead)
            val trailPunct = trail.trim()
            val commaAfter = Regex("^[,—–-]").containsMatchIn(trailPunct)
            val sentenceEnd = Regex("[.!?;:]").containsMatchIn(trailPunct)
            val endPunct = trailPunct.replace(Regex("^[,—–-]+"), "")

            if (!atStart && !commaBefore && trailPunct.isEmpty()) return@replace m.value
            if (entry.notAtStart && atStart) return@replace m.value
            if (entry.requireComma) {
                if (!commaBefore && !commaAfter && !atStart) return@replace m.value
                if (atStart && !commaAfter && !sentenceEnd) return@replace m.value
                if (endPunct.startsWith("?")) return@replace m.value
            }
            if (entry.notAfter.isNotEmpty() && !atStart && !commaBefore) {
                val prev = lastWord(prefix + lead)
                if (prev.isNotEmpty() && prev in entry.notAfter) return@replace m.value
            }
            if ((entry.commaAtStart || key == "like") && atStart && !commaAfter && !sentenceEnd) return@replace m.value

            if (atStart) {
                return@replace if (sentenceEnd) lead else "$lead$CAP"
            }
            val closing = if (endPunct.startsWith("?")) ".${endPunct.substring(1)}" else endPunct
            if (sentenceEnd) return@replace closing + space.ifEmpty { " " }
            if (commaBefore) return@replace if (isOpenerClause(lastClause(prefix))) ", " else " "
            " "
        }
        if (out == before) break
    }

    if (thorough) out = OPENER_CHAIN.replace(out) { m -> "${m.groupValues[1]}$CAP" }
    out = Regex("$CAP\\s*([\\s\\S]?)").replace(out) { m -> m.groupValues[1].uppercase() }
    out = (if (thorough) THOROUGH_TAIL else LIGHT_TAIL).replace(out, "")
    return out
        .replace(Regex("[ \\t]{2,}"), " ")
        .replace(Regex("\\s+([,.!?;:])"), "$1")
        .replace(Regex(",\\s*,"), ",")
        .replace(Regex("(?m)^[ \\t]+|[ \\t]+$"), "")
}
