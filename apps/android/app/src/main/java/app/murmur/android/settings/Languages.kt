package app.murmur.android.settings

/**
 * Dictation languages: ISO-639-1 codes every supported speech provider accepts, with the English
 * name the formatting model is told about. Mirror of apps/desktop/src/shared/languages.ts; keep
 * the two tables identical so both apps offer the same choices and build the same prompt.
 */
object Languages {
    const val AUTO = "auto"
    const val AUTO_LABEL = "Auto-detect"

    val ALL: List<Pair<String, String>> = listOf(
        "af" to "Afrikaans",
        "ar" to "Arabic",
        "bg" to "Bulgarian",
        "ca" to "Catalan",
        "zh" to "Chinese",
        "hr" to "Croatian",
        "cs" to "Czech",
        "da" to "Danish",
        "nl" to "Dutch",
        "en" to "English",
        "et" to "Estonian",
        "fi" to "Finnish",
        "fr" to "French",
        "de" to "German",
        "el" to "Greek",
        "he" to "Hebrew",
        "hi" to "Hindi",
        "hu" to "Hungarian",
        "id" to "Indonesian",
        "it" to "Italian",
        "ja" to "Japanese",
        "ko" to "Korean",
        "lv" to "Latvian",
        "lt" to "Lithuanian",
        "ms" to "Malay",
        "no" to "Norwegian",
        "fa" to "Persian",
        "pl" to "Polish",
        "pt" to "Portuguese",
        "ro" to "Romanian",
        "ru" to "Russian",
        "sr" to "Serbian",
        "sk" to "Slovak",
        "sl" to "Slovenian",
        "es" to "Spanish",
        "sw" to "Swahili",
        "sv" to "Swedish",
        "ta" to "Tamil",
        "th" to "Thai",
        "tr" to "Turkish",
        "uk" to "Ukrainian",
        "ur" to "Urdu",
        "vi" to "Vietnamese"
    )

    /** What the picker shows: auto-detect first, then every language by name. */
    val OPTIONS: List<Pair<String, String>> = listOf(AUTO to AUTO_LABEL) + ALL

    private val byCode: Map<String, String> = ALL.toMap()

    /**
     * English name of a dictation language, or null for auto-detect, blanks and unknown codes.
     * Region subtags are ignored ("pt-BR" -> Portuguese) so a value synced from another client
     * still resolves.
     */
    fun name(code: String?): String? {
        if (code.isNullOrBlank()) return null
        val base = code.trim().lowercase().split('-', '_')[0]
        if (base.isEmpty() || base == AUTO) return null
        return byCode[base]
    }

    /** Picker label for a stored value; unknown codes are shown as-is rather than disappearing. */
    fun label(code: String?): String {
        if (code.isNullOrBlank() || code.trim().lowercase() == AUTO) return AUTO_LABEL
        return name(code) ?: code
    }
}
