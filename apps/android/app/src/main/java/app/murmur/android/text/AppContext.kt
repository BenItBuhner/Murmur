package app.murmur.android.text

import app.murmur.android.settings.AppRule
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.Tone

/**
 * Android flavour of the desktop app-context detection (packages/text-engine/src/context.ts):
 * instead of window titles we get the package name of the app that owns the focused text field
 * from the accessibility service.
 */

enum class AppCategory(val id: String) {
    CHAT("chat"), EMAIL("email"), DOCUMENT("document"), CODE("code"), TERMINAL("terminal"),
    BROWSER("browser"), NOTES("notes"), UNKNOWN("unknown")
}

private val PACKAGE_PATTERNS: List<Pair<AppCategory, Regex>> = listOf(
    AppCategory.CHAT to Regex(
        "whatsapp|telegram|discord|slack|signal|securesms|messaging|messenger|orca|teams|zulip|mattermost|element|snapchat|line\\.android|viber|wechat|tencent\\.mm",
        RegexOption.IGNORE_CASE
    ),
    AppCategory.EMAIL to Regex(
        "gm(ail)?$|android\\.gm|outlook|thunderbird|mail|superhuman|spark|proton|fastmail|bluemail",
        RegexOption.IGNORE_CASE
    ),
    AppCategory.CODE to Regex("termux\\.styling|code|jetbrains|acode|spck", RegexOption.IGNORE_CASE),
    AppCategory.TERMINAL to Regex("termux|terminal|connectbot|juicessh", RegexOption.IGNORE_CASE),
    AppCategory.NOTES to Regex(
        "keep|notion|obsidian|evernote|onenote|bear|logseq|joplin|roam|standardnotes|simplenote",
        RegexOption.IGNORE_CASE
    ),
    AppCategory.DOCUMENT to Regex("docs|word|office|libreoffice|collabora", RegexOption.IGNORE_CASE),
    AppCategory.BROWSER to Regex(
        "chrome|firefox|fenix|edge|emmx|brave|opera|vivaldi|duckduckgo|samsung.+sbrowser",
        RegexOption.IGNORE_CASE
    )
)

/**
 * The app that owns the focused field. [label] is its launcher name when the system will tell us
 * ("Slack" for `com.Slack`); per-app rules match on either, the way the desktop's match on the
 * process name or the window title.
 */
data class AppContext(val packageName: String, val category: AppCategory, val label: String? = null)

fun classifyPackage(packageName: String, label: String? = null): AppContext {
    for ((category, re) in PACKAGE_PATTERNS) {
        if (re.containsMatchIn(packageName)) return AppContext(packageName, category, label)
    }
    return AppContext(packageName, AppCategory.UNKNOWN, label)
}

/** The first rule whose match is contained in the package name or the label (desktop: `findRule`). */
fun findRule(rules: List<AppRule>, ctx: AppContext): AppRule? {
    val hay = "${ctx.packageName} ${ctx.label ?: ""}".lowercase()
    return rules.firstOrNull { r ->
        val m = r.match.trim().lowercase()
        m.isNotEmpty() && hay.contains(m)
    }
}

fun autoTone(category: AppCategory): Tone = when (category) {
    AppCategory.CHAT -> Tone.CASUAL
    AppCategory.EMAIL, AppCategory.DOCUMENT -> Tone.PROFESSIONAL
    else -> Tone.NEUTRAL
}

fun resolveTone(globalTone: Tone, ctx: AppContext): Tone =
    if (globalTone != Tone.AUTO) globalTone else autoTone(ctx.category)

/** What the text stages need to know about the destination, already merged (desktop: ResolvedStyle). */
data class FormatStyle(
    val tone: Tone,
    val mode: FormattingMode,
    val instructions: String,
    val trailingSpace: Boolean,
    /** The per-app rule that applied, if any. */
    val rule: AppRule? = null
)

/**
 * Precedence, as on the desktop: the matching per-app rule, then the global settings, then the
 * destination's defaults. A rule's instructions are appended to the global ones.
 */
fun resolveStyle(s: MurmurSettings, ctx: AppContext): FormatStyle {
    val rule = findRule(s.appRules, ctx)
    val tone = when {
        rule != null && rule.tone != Tone.AUTO -> rule.tone
        s.tone != Tone.AUTO -> s.tone
        else -> autoTone(ctx.category)
    }
    val instructions = listOf(s.llmInstructions.trim(), rule?.instructions?.trim() ?: "")
        .filter { it.isNotEmpty() }
        .joinToString("\n\n")
    return FormatStyle(
        tone = tone,
        mode = rule?.formatting ?: s.formattingMode,
        instructions = instructions,
        trailingSpace = rule?.trailingSpace ?: s.trailingSpace,
        rule = rule
    )
}

/** Code and terminals: identifiers and syntax must survive an edit (desktop: `isTechnical`). */
fun isTechnical(category: AppCategory): Boolean = category == AppCategory.CODE || category == AppCategory.TERMINAL

/** Same wording as the TypeScript engine's `categoryHint`; part of the golden prompt contract. */
fun categoryHint(category: AppCategory): String = when (category) {
    AppCategory.CHAT -> "a chat message"
    AppCategory.EMAIL -> "an email"
    AppCategory.CODE -> "a code editor"
    AppCategory.TERMINAL -> "a terminal"
    AppCategory.DOCUMENT -> "a document"
    AppCategory.NOTES -> "a notes app"
    AppCategory.BROWSER -> "a web page form field"
    else -> "a text field"
}
