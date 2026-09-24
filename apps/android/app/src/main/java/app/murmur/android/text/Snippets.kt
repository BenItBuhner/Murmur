package app.murmur.android.text

import app.murmur.android.settings.Snippet
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Port of packages/text-engine/src/snippets.ts. Snippets are expanded by the client after
 * finishing, because their content may depend on the device (local time, clipboard).
 */

/** What the placeholders are filled from; the defaults are the moment of expansion on this device. */
data class SnippetContext(
    val now: Date = Date(),
    val clipboard: String? = null,
    val locale: Locale = Locale.getDefault()
)

data class SnippetResult(val text: String, val expanded: List<String>)

private const val WB_START = "(?<![\\p{L}\\p{N}_])"
private const val WB_END = "(?![\\p{L}\\p{N}_])"

/**
 * Replace spoken triggers with their stored content. The trigger may be prefixed with
 * "insert"/"paste"/"snippet" and may carry trailing punctuation from the transcriber. Longer
 * triggers are tried first so "my work sig" is never eaten by "my sig".
 * Placeholders: {date} {time} {day} {datetime} {clipboard}
 */
fun expandSnippets(text: String, snippets: List<Snippet>, ctx: SnippetContext = SnippetContext()): SnippetResult {
    val expanded = ArrayList<String>()
    if (snippets.isEmpty() || text.isEmpty()) return SnippetResult(text, expanded)
    var out = text
    val sorted = snippets.filter { it.trigger.isNotBlank() }.sortedByDescending { it.trigger.length }
    for (s in sorted) {
        val trig = Regex.escape(s.trigger.trim()).let { escapeSpaces(it) }
        val re = Regex("$WB_START(?:(?:insert|paste|snippet)\\s+)?$trig$WB_END[.,!?;:]*", RegexOption.IGNORE_CASE)
        if (!re.containsMatchIn(out)) continue
        val content = fillPlaceholders(s.content, ctx)
        out = re.replace(out) {
            expanded.add(s.trigger)
            Regex.escapeReplacement(content)
        }
    }
    return SnippetResult(out, expanded)
}

/**
 * `Regex.escape` wraps the trigger in \Q…\E, inside which "\s+" would be literal; split the
 * quoting around each run of whitespace so the transcript may space the words differently.
 */
private fun escapeSpaces(quoted: String): String =
    quoted.split(Regex("\\s+")).joinToString("\\E\\s+\\Q")

fun fillPlaceholders(content: String, ctx: SnippetContext): String {
    val now = ctx.now
    val locale = ctx.locale
    return content
        .replace(Regex("\\{date\\}", RegexOption.IGNORE_CASE), DateFormat.getDateInstance(DateFormat.LONG, locale).format(now))
        .replace(Regex("\\{time\\}", RegexOption.IGNORE_CASE), DateFormat.getTimeInstance(DateFormat.SHORT, locale).format(now))
        .replace(Regex("\\{day\\}", RegexOption.IGNORE_CASE), SimpleDateFormat("EEEE", locale).format(now))
        .replace(
            Regex("\\{datetime\\}", RegexOption.IGNORE_CASE),
            DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM, locale).format(now)
        )
        .replace(Regex("\\{clipboard\\}", RegexOption.IGNORE_CASE), ctx.clipboard ?: "")
}
