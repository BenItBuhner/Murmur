package app.murmur.android.text

import app.murmur.android.settings.Tone

/**
 * Port of packages/text-engine/src/profiles.ts. A profile is one choice for how dictations read:
 * the tone, how much layout the model may add (lists and paragraphs), the casing and whether
 * grammar is polished or kept as spoken. Chosen for every app and, optionally, per app on its
 * rule. None of it adds a round trip: layout and grammar are lines of the one formatting request,
 * casing runs on the device. The prompt lines, [applyCasing] and [keepParagraphs] are pinned to the
 * TypeScript engine by GoldenEngineTest.
 */

enum class Layout(val id: String) {
    AUTO("auto"), MINIMAL("minimal"), BALANCED("balanced"), STRUCTURED("structured");

    companion object {
        fun from(id: String?): Layout = entries.firstOrNull { it.id == id } ?: AUTO
    }
}

/** A [Layout] decided for a destination; LISTS is today's behaviour (lists when enumerated). */
enum class ResolvedLayout { MINIMAL, LISTS, BALANCED, STRUCTURED }

enum class Casing(val id: String) { STANDARD("standard"), LOWERCASE("lowercase") }

enum class Grammar(val id: String) {
    POLISH("polish"), AS_SPOKEN("as-spoken");

    companion object {
        fun from(id: String?): Grammar = if (id == AS_SPOKEN.id) AS_SPOKEN else POLISH
    }
}

data class Profile(
    val id: String,
    val name: String,
    val description: String,
    val tone: Tone,
    val layout: Layout,
    val casing: Casing,
    val grammar: Grammar
)

object Profiles {
    val DEFAULT = Profile(
        "default", "Default",
        "Adapts to the app: casual in chat, paragraphs and lists in email and documents.",
        Tone.AUTO, Layout.AUTO, Casing.STANDARD, Grammar.POLISH
    )
    val CASUAL = Profile(
        "casual", "Casual",
        "Lower-case, relaxed messages with no final period. Names keep their capitals.",
        Tone.CASUAL, Layout.AUTO, Casing.LOWERCASE, Grammar.POLISH
    )
    val POLISHED = Profile(
        "polished", "Polished",
        "Professional, with paragraphs at each new topic and lists for any series of items.",
        Tone.PROFESSIONAL, Layout.STRUCTURED, Casing.STANDARD, Grammar.POLISH
    )
    val AS_SPOKEN = Profile(
        "as-spoken", "As spoken",
        "Your own words and grammar, punctuated. No lists or paragraphs you did not dictate.",
        Tone.NEUTRAL, Layout.MINIMAL, Casing.STANDARD, Grammar.AS_SPOKEN
    )

    /** In picker order; the ids are the desktop's `PROFILE_IDS`. */
    val ALL: List<Profile> = listOf(DEFAULT, CASUAL, POLISHED, AS_SPOKEN)

    /** A stored id, or Default when it is unknown (a profile from a newer build, say). */
    fun of(id: String?): Profile = ALL.firstOrNull { it.id == id } ?: DEFAULT
}

fun resolveLayout(layout: Layout?, category: AppCategory): ResolvedLayout = when (layout) {
    Layout.MINIMAL -> ResolvedLayout.MINIMAL
    Layout.BALANCED -> ResolvedLayout.BALANCED
    Layout.STRUCTURED -> ResolvedLayout.STRUCTURED
    else -> when (category) {
        AppCategory.EMAIL, AppCategory.DOCUMENT, AppCategory.NOTES -> ResolvedLayout.BALANCED
        else -> ResolvedLayout.LISTS
    }
}

fun layoutLine(layout: ResolvedLayout): String = when (layout) {
    ResolvedLayout.MINIMAL -> "Layout: running text; no list or line break the speaker did not dictate."
    ResolvedLayout.BALANCED -> "Layout: paragraphs. In text of four or more sentences, leave a blank line where the speaker moves to a new topic. A counted enumeration (\"first..., second...\") is still a list, one item per line."
    ResolvedLayout.STRUCTURED -> "Layout: structured. Leave a blank line where the speaker moves to a new topic. Three or more parallel items or steps said in a row go one per line as a list, even if not counted, each in the speaker's own words. Two items stay in the sentence; sentences that are not a series, and pieces of one sentence cut at pauses, stay prose."
    ResolvedLayout.LISTS -> ""
}

fun grammarLine(grammar: Grammar?): String =
    if (grammar == Grammar.AS_SPOKEN) {
        "Grammar: as spoken. Keep the speaker's own wording and grammar, even where it is informal; fix only punctuation, capitalization, fillers, stutters and spoken commands."
    } else ""

fun addsParagraphs(layout: ResolvedLayout): Boolean =
    layout == ResolvedLayout.BALANCED || layout == ResolvedLayout.STRUCTURED

/**
 * Would a long enough dictation into [category] get the layout pass at all (desktop:
 * layoutPossible)? Never in chat, even when structured: there the prompt's Layout line is all.
 */
fun layoutPossible(category: AppCategory, layout: Layout?): Boolean {
    if (layout == Layout.MINIMAL) return false
    return category != AppCategory.CHAT && category != AppCategory.CODE && category != AppCategory.TERMINAL
}

/** Frequent message openers COMMON_WORDS leaves out (it skips some short function words). */
private val CASUAL_WORDS: Set<String> = (
    "hey hi hello ok okay lol lmao btw omg haha yep yup nope yeah ya a an in do so my see good way day will to of or if on as at by up go no oh um " +
        "don't doesn't didn't won't can't isn't aren't wasn't let's that's it's what's there's here's"
    ).split(' ').toSet()

private fun lowerable(lower: String): Boolean =
    CASUAL_WORDS.contains(lower.replace('’', '\'')) || COMMON_WORDS.contains(lower.replace(Regex("['’].*$"), ""))

private val SENTENCE_START = Regex("((?:^|\\n)\\s*(?:[-*•]\\s+|\\d{1,3}[.)]\\s+)?|[.!?][\"')\\]]*\\s+)(\\p{Lu}[\\p{Ll}'’]*)(?![\\p{L}\\p{N}])")
private val FINAL_PERIOD = Regex("[^.]\\.$")
private val INITIALISM_END = Regex("\\b\\p{L}\\.\\p{L}\\.$")

/** Capitalized after a word or a comma somewhere in [text]: a name ("Will"), not a sentence start. */
private fun capitalizedMidSentence(word: String, text: String): Boolean =
    Regex("""[\p{L}\p{N},;:]\s+""" + Regex.escape(word) + """(?![\p{L}'’])""").containsMatchIn(text)

/**
 * Lower-case casing, the "very casual" chat style: sentence starts lose their capital (frequent
 * words only, so names, "I" and acronyms keep theirs, as do words the text capitalizes
 * mid-sentence and the dictionary's [keep]) and a one-line message loses its final
 * period. Mirrors `applyCasing` in profiles.ts.
 */
fun applyCasing(text: String, casing: Casing?, category: AppCategory? = null, keep: Collection<String> = emptyList()): String {
    if (casing != Casing.LOWERCASE || category == AppCategory.CODE || category == AppCategory.TERMINAL) return text
    var out = SENTENCE_START.replace(text) { m ->
        val sep = m.groupValues[1]
        val word = m.groupValues[2]
        val lower = word.lowercase()
        if (word == "I" || Regex("^i['’]").containsMatchIn(lower) || !lowerable(lower)) m.value
        else if (word in keep || capitalizedMidSentence(word, text)) m.value
        else sep + lower
    }
    val trimmed = out.trimEnd()
    if (!trimmed.contains('\n') && FINAL_PERIOD.containsMatchIn(trimmed) && !INITIALISM_END.containsMatchIn(trimmed))
        out = trimmed.dropLast(1) + out.substring(trimmed.length)
    return out
}

private val BLANK_LINE = Regex("[ \\t]*\\n[ \\t]*\\n\\s*")
private val SINGLE_BREAK = Regex("[ \\t]*\\n[ \\t]*")
private val SENTENCE_END = Regex("[.!?:…][\"'’”)\\]]*$")

/** "Hi Sam," / "Dear Ms. Alvarez," alone on the first line. */
private val GREETING_LINE = Regex(
    "^((?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\\b[^\\n,!?]{0,40},)[ \\t]*\\n\\s*",
    RegexOption.IGNORE_CASE
)

/**
 * Line breaks the model added on its own (to text with no list), kept only where a layout allows
 * them: a blank line after a sentence end stays a paragraph break; any other break is a space.
 */
fun keepParagraphs(text: String): String {
    // A greeting on its own line opens the letter: a paragraph of its own.
    val paragraphs = GREETING_LINE.replaceFirst(text, "$1\n\n").split(BLANK_LINE)
        .map { it.replace(SINGLE_BREAK, " ").trim() }.filter { it.isNotEmpty() }
    if (paragraphs.isEmpty()) return ""
    val sb = StringBuilder(paragraphs[0])
    for (i in 1 until paragraphs.size) {
        val breaks = SENTENCE_END.containsMatchIn(paragraphs[i - 1]) ||
            (i == 1 && GREETING_LINE.containsMatchIn(paragraphs[0] + "\n"))
        if (breaks) sb.append("\n\n") else sb.append(' ')
        sb.append(paragraphs[i])
    }
    return sb.toString()
}
