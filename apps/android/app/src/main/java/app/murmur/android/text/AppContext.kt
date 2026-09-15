package app.murmur.android.text

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

data class AppContext(val packageName: String, val category: AppCategory)

fun classifyPackage(packageName: String): AppContext {
    for ((category, re) in PACKAGE_PATTERNS) {
        if (re.containsMatchIn(packageName)) return AppContext(packageName, category)
    }
    return AppContext(packageName, AppCategory.UNKNOWN)
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
    val trailingSpace: Boolean
)

fun resolveStyle(s: MurmurSettings, ctx: AppContext): FormatStyle = FormatStyle(
    tone = resolveTone(s.tone, ctx),
    mode = s.formattingMode,
    instructions = s.llmInstructions.trim(),
    trailingSpace = s.trailingSpace
)

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
