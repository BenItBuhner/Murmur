package app.murmur.android.text

import app.murmur.android.settings.Tone

/**
 * Android flavour of the desktop app-context detection: instead of window titles we get
 * the package name of the app that owns the focused text field from the accessibility service.
 */

enum class AppCategory { CHAT, EMAIL, DOCUMENT, CODE, TERMINAL, BROWSER, NOTES, UNKNOWN }

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

fun toneDescription(tone: Tone): String = when (tone) {
    Tone.CASUAL ->
        "Casual and friendly: contractions are fine, keep it light, sentence fragments are acceptable in chat."
    Tone.PROFESSIONAL -> "Professional and polished: complete sentences, correct grammar, no slang."
    else -> "Neutral and clear: natural sentences, faithful to how the speaker talks."
}

fun categoryHint(category: AppCategory): String = when (category) {
    AppCategory.CHAT -> "a chat message"
    AppCategory.EMAIL -> "an email"
    AppCategory.CODE ->
        "a code editor (preserve identifiers, file names, and technical terms exactly; do not add prose punctuation to code)"
    AppCategory.TERMINAL ->
        "a terminal (likely a command; keep it on one line and do not add trailing punctuation)"
    AppCategory.DOCUMENT -> "a document"
    AppCategory.NOTES -> "a notes app"
    AppCategory.BROWSER -> "a web page form field"
    else -> "a text field"
}
