package app.murmur.android.text

/**
 * Port of packages/text-engine/src/clean.ts: the "needs no model" decision. Every formatting call
 * carries a ~1,200-token fixed prompt, and a short dictation the speech model already punctuated
 * gains nothing from it. A transcript qualifies only when nothing in it or around it could make
 * the model change the text: short, already punctuated, plain English prose with no filler,
 * stutter, spoken command, self-correction, number or list cue, going to a destination with no
 * special needs, under default style settings. Every rule errs toward calling the model. Pinned to
 * the TypeScript engine by GoldenEngineTest: decisions, reasons and word lists must agree.
 */

data class CleanDecision(val clean: Boolean, val reason: String? = null)

object Clean {
    /** Longest transcript, in words, the rules may finish on their own (see clean.ts for why 12). */
    const val MAX_WORDS = 12

    // ---- lexicon (lower-case ASCII; part of the golden contract) ------------------------------

    val HESITATION_WORDS: List<String> = DEFAULT_FILLERS + listOf(
        "oh", "basically", "actually", "literally", "honestly", "anyway", "anyways", "kinda", "sorta"
    )

    val HESITATION_PHRASES: List<String> = listOf("you know", "i mean", "kind of", "sort of")

    val COMMAND_WORDS: List<String> = listOf(
        "quote", "quotes", "unquote", "comma", "period", "colon", "semicolon", "hyphen", "dash",
        "ampersand", "asterisk", "underscore", "slash", "backslash", "parenthesis", "parentheses",
        "bracket", "brackets", "ellipsis", "newline", "backspace", "caps", "capital", "capitalize",
        "uppercase", "lowercase"
    )

    val COMMAND_PHRASES: List<String> = listOf(
        "new line", "new paragraph", "line break", "paragraph break", "question mark",
        "exclamation point", "exclamation mark", "full stop", "open paren", "close paren", "all caps",
        "scratch that", "delete that", "strike that", "undo that", "erase that", "press enter",
        "hit enter", "select all", "open quote", "close quote", "end quote"
    )

    val CORRECTION_PHRASES: List<String> = listOf(
        "i meant", "no wait", "wait no", "or rather", "make that", "never mind", "nevermind",
        "forget that", "correction"
    )

    val ENUMERATION_WORDS: List<String> = listOf("firstly", "secondly", "thirdly", "lastly", "bullet", "bullets")

    val ENUMERATION_PHRASES: List<String> = listOf("bullet point", "bullet points", "next item", "next point")

    /** Frequent function words of other languages in plain ASCII; words that are also English are left out. */
    val FOREIGN_WORDS: List<String> = listOf(
        // German
        "aber", "auch", "bist", "bitte", "danke", "das", "dass", "der", "dich", "die", "du", "ein",
        "eine", "einem", "einen", "einer", "es", "euch", "gibt", "habe", "haben", "heute", "hier",
        "ich", "ihm", "ihn", "ihr", "im", "ist", "ja", "jetzt", "kann", "mich", "mir", "morgen",
        "muss", "nein", "nicht", "noch", "oder", "schon", "sehr", "sie", "sind", "soll", "und",
        "uns", "wenn", "wie", "wir", "wird", "wo", "zu",
        // French (also "de", shared with Spanish, Portuguese and Dutch)
        "alors", "au", "aussi", "aux", "avec", "avez", "avons", "bonjour", "ce", "ces", "cette",
        "dans", "de", "demain", "des", "elle", "elles", "et", "il", "ils", "je", "la", "le", "les",
        "mais", "merci", "moi", "notre", "nous", "oui", "pas", "peut", "peux", "qui", "que", "sommes",
        "sont", "suis", "sur", "toi", "tu", "une", "vais", "votre", "vous",
        // Spanish
        "del", "el", "ellas", "ellos", "eres", "esta", "este", "esto", "gracias", "hola", "hoy",
        "las", "lo", "los", "muy", "nosotros", "pero", "por", "porque", "puede", "puedes", "puedo",
        "quiero", "quieres", "se", "si", "somos", "tengo", "tiene", "tienes", "un", "una", "unas",
        "unos", "usted", "ustedes",
        // Italian
        "anche", "che", "ciao", "cosa", "degli", "dei", "della", "delle", "dello", "di", "domani",
        "gli", "grazie", "lei", "loro", "lui", "nel", "nella", "noi", "oggi", "posso", "puoi",
        "questa", "questo", "sei", "siamo", "sono", "tutto", "voi", "vorrei",
        // Portuguese
        "agora", "aqui", "bom", "da", "dos", "ela", "elas", "ele", "eles", "essa", "esse", "hoje",
        "isso", "isto", "mas", "muito", "nas", "nos", "obrigada", "obrigado", "quero", "tem", "tenho",
        "tudo", "uma", "vamos",
        // Dutch
        "alle", "deze", "dit", "een", "en", "geen", "graag", "heb", "hebben", "heeft", "het", "ik",
        "jij", "jullie", "maar", "mijn", "naar", "niet", "nog", "nu", "ook", "voor", "wel", "wij",
        "wordt", "ze", "zij", "zijn", "zou",
        // Swedish, Norwegian, Danish
        "det", "ett", "ikke", "inte", "jag", "jeg", "och", "og", "som",
        // Polish
        "czy", "dla", "jest", "nie", "tak",
        // Turkish
        "ama", "bir", "bu", "evet", "tamam", "ve", "yok",
        // Indonesian, Malay
        "akan", "bisa", "dengan", "ini", "itu", "kasih", "saya", "sudah", "terima", "tidak", "untuk",
        "yang",
        // Tagalog
        "ako", "ang", "mga", "salamat"
    )

    // ---- patterns ------------------------------------------------------------------------------
    // `\z` is the true end of input: Java's `$` would also match before a final line break.

    private val ALLOWED_CHARS = Regex("^[a-z0-9 .,!?'’-]*\\z")
    private val TERMINAL = Regex("(?<!\\.)[.!?]\\z")
    private val PRECEDING_BOUNDARY = Regex("(?:[.!?…][\"'”’)\\]]*[ \\t]*|\\n[ \\t]*)\\z")
    private val OPENER = Regex("^(?:so|well|alright|(?:okay|ok|yeah|yes|right|and|but|now|then)\\s*,?\\s*so)(?![a-z'’])")
    private val PAUSE_LIKE = Regex("(?:^|,\\s*)like(?![a-z'’])|(?<![a-z'’])like\\s*,")
    private val CORRECTION = Regex(",\\s*no(?![a-z'’])|(?:^|[,.]\\s*)wait(?![a-z'’])")
    private val WORD = Regex("[a-z]+(?:['’][a-z]+)?")
    private val SENTENCE_SPLIT = Regex("(?<=[.!?])\\s+")
    private val QUESTION_END = Regex("\\?\\z")
    private val DIGIT = Regex("[0-9]")

    private fun phraseRegex(phrases: List<String>): Regex =
        Regex("(?<![a-z'’])(?:${phrases.joinToString("|") { it.replace(" ", "\\s+") }})(?![a-z'’])")

    private val HESITATION_PHRASE_RE = phraseRegex(HESITATION_PHRASES)
    private val COMMAND_PHRASE_RE = phraseRegex(COMMAND_PHRASES)
    private val CORRECTION_PHRASE_RE = phraseRegex(CORRECTION_PHRASES)
    private val ENUMERATION_PHRASE_RE = phraseRegex(ENUMERATION_PHRASES)
    private val HESITATION_SET = HESITATION_WORDS.toSet()
    private val COMMAND_SET = COMMAND_WORDS.toSet()
    private val ENUMERATION_SET = ENUMERATION_WORDS.toSet()
    private val FOREIGN_SET = FOREIGN_WORDS.toSet()

    /** A word, or a run of two or three words, said twice in a row. */
    private fun hasStutter(words: List<String>): Boolean {
        for (n in 1..3) {
            var i = 0
            while (i + 2 * n <= words.size) {
                var same = true
                var k = 0
                while (k < n && same) {
                    same = words[i + k] == words[i + n + k]
                    k++
                }
                if (same) return true
                i++
            }
        }
        return false
    }

    /** Decide whether the prepared transcript needs the model; reads its text and stages. */
    fun alreadyClean(prepared: PreparedTranscript, ctx: FormatContext, maxWords: Int = MAX_WORDS): CleanDecision {
        fun no(reason: String) = CleanDecision(false, reason)

        // Where the text goes and how the user wants it: anything beyond the defaults is the model's job.
        if (ctx.category == AppCategory.CODE || ctx.category == AppCategory.TERMINAL) return no("destination")
        if (!ctx.instructions?.trim().isNullOrEmpty()) return no("instructions")
        if (ctx.tone != autoTone(ctx.category)) return no("tone")
        val lang = (ctx.language ?: "auto").trim().lowercase().split(Regex("[-_]"))[0]
        if (lang.isNotEmpty() && lang != "auto" && lang != "en") return no("language")
        val preceding = ctx.precedingText ?: ""
        if (preceding.trim().isNotEmpty() && !PRECEDING_BOUNDARY.containsMatchIn(preceding)) return no("preceding-text")

        val text = prepared.text
        val lower = text.lowercase()
        for (phrase in ctx.keepVerbatim) {
            val p = phrase.trim().lowercase()
            if (p.isNotEmpty() && lower.contains(p)) return no("verbatim")
        }

        // The transcript itself.
        if ("line-commands" in prepared.stages || "literal-punctuation" in prepared.stages || text.contains('\n')) return no("command")
        if (countWords(text) > maxWords) return no("long")
        if (!TERMINAL.containsMatchIn(text)) return no("unpunctuated")
        if (!ALLOWED_CHARS.containsMatchIn(lower)) return no("characters")

        val words = WORD.findAll(lower).map { it.value }.toList()
        fun has(set: Set<String>) = words.any { it in set }
        if (has(HESITATION_SET) || HESITATION_PHRASE_RE.containsMatchIn(lower)) return no("filler")
        if (OPENER.containsMatchIn(lower) || PAUSE_LIKE.containsMatchIn(lower)) return no("filler")
        if (hasStutter(words)) return no("stutter")
        if (CORRECTION_PHRASE_RE.containsMatchIn(lower) || CORRECTION.containsMatchIn(lower)) return no("correction")
        if (has(COMMAND_SET) || COMMAND_PHRASE_RE.containsMatchIn(lower)) return no("command")
        if (has(ENUMERATION_SET) || ENUMERATION_PHRASE_RE.containsMatchIn(lower)) return no("enumeration")
        if (DIGIT.containsMatchIn(lower) || words.any { NumberSignature.isNumberWord(it) }) return no("number")
        // A question the speech model ended with a period would come back with its "?".
        for (sentence in text.split(SENTENCE_SPLIT)) {
            if (QUESTION_START.containsMatchIn(sentence) && !QUESTION_END.containsMatchIn(sentence)) return no("question")
        }
        if (has(FOREIGN_SET)) return no("foreign")
        return CleanDecision(true)
    }
}
