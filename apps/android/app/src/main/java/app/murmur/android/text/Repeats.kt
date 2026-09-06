package app.murmur.android.text

import app.murmur.android.settings.RepetitionScope

/**
 * Kotlin port of apps/desktop/src/core/text/repeats.ts.
 *   WORDS     "the the report", "I, I think", part-word stutters "th- the"
 *   PHRASES   repeated runs of up to five words: "I think, I think we should"
 *   THOROUGH  abandoned restarts: "I want to, I need to go" -> "I need to go"
 *
 * Repetition is only noise when it is a stumble. People stumble over the small words that hold a
 * sentence together ("I, I think", "the the report"); they repeat content words on purpose, for
 * emphasis or feeling ("no, no, no", "very, very slowly", "fuck, fuck, fuck", "go go go"). So a
 * repeat separated by pauses, or said three or more times, stays unless the word is one people
 * stumble over; a bare double ("report report") is a stutter unless the word is a usual emphatic.
 */

private const val W = "[\\p{L}\\p{N}'’]"
private const val NOT_W = "(?<![\\p{L}\\p{N}'’])"
private const val END_W = "(?![\\p{L}\\p{N}'’])"

/**
 * Words people stumble over rather than stress: pronouns, articles, prepositions, conjunctions,
 * auxiliaries, question words. Their repeats are stutters whatever the punctuation.
 */
val STUTTER_PRONE = setOf(
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "us", "them", "my", "your", "his", "its",
    "our", "their", "a", "an", "the", "this", "that", "these", "those", "to", "of", "in", "at", "for",
    "with", "from", "by", "about", "into", "and", "but", "or", "because", "if", "is", "are", "was",
    "were", "be", "been", "am", "do", "does", "did", "have", "has", "had", "will", "would", "can",
    "could", "should", "shall", "may", "might", "must", "what", "who", "where", "when", "why", "how",
    "which", "just", "like", "let", "gonna", "wanna", "i'm", "it's", "that's", "there's", "don't"
)

/** Usual emphatics: even a bare double ("very very good", "no no") is on purpose. */
private val EMPHASIS = setOf(
    "no", "yes", "yeah", "very", "really", "so", "go", "come", "please", "okay", "ok", "wait", "stop",
    "hey", "bye", "ha", "haha", "well", "again", "never", "ever", "more", "now", "quick", "quickly",
    "many", "much", "far", "long", "down", "up", "on", "out", "there", "here", "ah", "oh", "wow", "hi",
    "hello", "hurry", "run", "sorry", "thanks"
)
private val GRAMMATICAL_DOUBLES = setOf("that", "had")

private val PART_WORD_STUTTER = Regex("$NOT_W(\\p{L}{1,3})[-–—]\\s+(?=\\1\\p{L})", RegexOption.IGNORE_CASE)
private val WORD_REPEAT = Regex("$NOT_W($W+)((?:\\s*[,–—-]?\\s+\\1$END_W)+)", RegexOption.IGNORE_CASE)
private val PHRASE_REPEAT = Regex("$NOT_W($W+(?:\\s+$W+){1,4})(?:\\s*[,–—-]?\\s+\\1$END_W)+", RegexOption.IGNORE_CASE)

private val RESTART_TAILS = setOf(
    "to", "the", "a", "an", "and", "of", "in", "on", "at", "for", "with", "that", "is", "was", "are", "were",
    "it", "it's", "should", "could", "would", "can", "will", "might", "may", "must", "have", "has", "had",
    "be", "been", "do", "does", "did", "don't", "doesn't", "didn't", "not", "going", "gonna", "want",
    "wanna", "need", "my", "your", "our", "their", "this", "these", "those"
)
private val RESTART_SEPARATOR = Regex("\\s*[,–—-]\\s+($W+)(\\s+)($W+)", RegexOption.IGNORE_CASE)
private val WORD_TOKEN = Regex("$W+")

private val PAUSE = Regex("[,–—-]")

fun collapseRepeats(text: String, scope: RepetitionScope = RepetitionScope.WORDS): String {
    if (text.isEmpty()) return text
    var out = PART_WORD_STUTTER.replace(PART_WORD_STUTTER.replace(text, ""), "")
    out = WORD_REPEAT.replace(out) { m ->
        val word = m.groupValues[1]
        val rest = m.groupValues[2]
        val lower = word.lowercase()
        val paused = PAUSE.containsMatchIn(rest)
        when {
            // "five five five one two one two" is a phone number, not a stutter.
            lower in NUMBER_WORDS || Regex("^\\d+$").matches(lower) -> m.value
            lower in GRAMMATICAL_DOUBLES && !paused -> m.value
            // "I, I think", "the the report": a stumble however it was said.
            lower in STUTTER_PRONE -> word
            // "fuck, fuck, fuck", "very, very slowly": the pauses are the speaker stressing each copy.
            paused -> m.value
            // "go go go", "no no no": nobody says a word three times by accident.
            1 + WORD_TOKEN.findAll(rest).count() >= 3 || lower in EMPHASIS -> m.value
            else -> word
        }
    }
    if (scope == RepetitionScope.WORDS) return out
    for (guard in 0 until 5) {
        val next = PHRASE_REPEAT.replace(out) { m ->
            val phrase = m.groupValues[1]
            val rest = m.value.substring(phrase.length)
            val words = WORD_TOKEN.findAll(phrase).map { it.value.lowercase() }.toList()
            when {
                // "go go go go": one word said many times was already judged by the word pass.
                words.all { it == words[0] } -> m.value
                // "go away, go away" is said on purpose; "I think, I think we should" is a restart.
                PAUSE.containsMatchIn(rest) && words[0] !in STUTTER_PRONE -> m.value
                else -> phrase
            }
        }
        if (next == out) break
        out = next
    }
    if (scope != RepetitionScope.THOROUGH) return out
    return removeFalseStarts(out)
}

/** "I want to, I need to go" -> "I need to go"; see the desktop implementation for the rules. */
fun removeFalseStarts(text: String): String {
    val out = StringBuilder()
    var cursor = 0
    for (m in RESTART_SEPARATOR.findAll(text)) {
        val c1 = m.groupValues[1]
        val gap = m.groupValues[2]
        val c2 = m.groupValues[3]
        val end = m.range.last + 1
        if (m.range.first < cursor) continue
        val before = text.substring(cursor, m.range.first)
        val words = WORD_TOKEN.findAll(before).toList()
        var cut = -1
        var fragFirst = ""
        val tail = words.lastOrNull()
        if (tail != null && tail.value.lowercase() in RESTART_TAILS &&
            before.substring(tail.range.last + 1).isBlank()
        ) {
            var n = 2
            while (n <= 4 && n <= words.size) {
                val frag = words.subList(words.size - n, words.size)
                val fragText = before.substring(frag[0].range.first)
                if (Regex("[.,;:!?\\n]").containsMatchIn(fragText)) break
                if (frag[0].value.lowercase() != c1.lowercase()) {
                    n++
                    continue
                }
                if (frag[1].value.lowercase() == c2.lowercase()) break
                cut = frag[0].range.first
                fragFirst = frag[0].value
                break
            }
        }
        if (cut >= 0) {
            val restart = if (fragFirst.first().isUpperCase()) c1.replaceFirstChar { it.uppercaseChar() } else c1
            out.append(before, 0, cut).append(restart).append(gap).append(c2)
        } else {
            out.append(text, cursor, end)
        }
        cursor = end
    }
    out.append(text, cursor, text.length)
    return out.toString()
}
