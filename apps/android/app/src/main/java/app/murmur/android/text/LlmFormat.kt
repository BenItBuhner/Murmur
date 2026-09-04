package app.murmur.android.text

import app.murmur.android.llm.ChatMessage
import app.murmur.android.settings.Tone

/**
 * Port of the desktop smart-formatting prompt and guard rails
 * (apps/desktop/src/core/text/llm-prompt.ts). The exact same system prompt, so the same
 * models behave identically across desktop and Android.
 */

fun buildFormatMessages(
    raw: String,
    dictionaryTerms: List<String>,
    tone: Tone,
    app: AppContext
): List<ChatMessage> {
    val terms = dictionaryTerms.map { it.trim() }.filter { it.isNotEmpty() }.take(80)
    val lines = mutableListOf(
        "You are the cleanup stage inside a voice dictation tool. The user spoke the text below and a speech recognizer transcribed it. Rewrite it as the polished text they intended to type.",
        "",
        "Rules:",
        "- Preserve the speaker's words, meaning, order, and language. Never summarize, expand, answer, translate, or add anything they did not say.",
        "- Fix punctuation, capitalization, and obvious transcription errors.",
        "- Remove filler sounds (um, uh, er, hmm) and verbal tics used as filler (like, you know, sort of, I mean); collapse stutters and repeated words. Keep every word that carries meaning, including greetings and openers such as \"hey\", \"so\", \"okay\", \"thanks\".",
        "- Apply self-corrections: \"Tuesday, no, Wednesday\" becomes \"Wednesday\"; \"scratch that\" removes the phrase before it.",
        "- Format an enumeration (\"first... second...\" or \"one... two...\") as a list with \"- \" bullets or \"1.\" numbering, one item per line. Otherwise keep the speaker's paragraphs.",
        "- Use digits for quantities, times, dates, money, and versions (\"five pm\" -> \"5 pm\", \"version two point three\" -> \"version 2.3\").",
        "- Spoken \"new line\" means a line break and \"new paragraph\" means a blank line."
    )
    if (terms.isNotEmpty()) lines.add("- Spell these terms exactly as written: ${terms.joinToString(", ")}.")
    lines.add("- Tone: ${toneDescription(tone)}")
    lines.add("- The text is going into ${categoryHint(app.category)}${if (app.packageName.isNotEmpty()) " (${app.packageName})" else ""}.")
    lines.add("- Do not wrap the result in quotes or code fences. Do not add greetings, sign-offs, notes, or explanations. If the transcript is empty or only noise, output nothing.")
    lines.add("")
    lines.add("Output only the cleaned text.")
    return listOf(
        ChatMessage("system", lines.joinToString("\n")),
        ChatMessage("user", raw)
    )
}

private val CHATTY_PREFIX = Regex(
    "^(?:sure|certainly|of course|here(?:'s| is| are)|i(?:'m| am) sorry|as an ai|i can(?:'t|not)|the cleaned|cleaned text|here you go|i'd be happy)\\b",
    RegexOption.IGNORE_CASE
)
private val QUESTION_START = Regex(
    "^(?:what|who|whom|whose|when|where|why|how|which|is|are|was|were|do|does|did|can|could|will|would|should|shall|may|might)\\b",
    RegexOption.IGNORE_CASE
)
private val LABEL_PREFIX = Regex(
    "^(?:(?:here is |here's )?(?:the )?(?:cleaned(?: up)?|formatted|polished|final|corrected|edited)(?: text| version| transcript)?|output|result|text|transcript)\\s*:\\s*",
    RegexOption.IGNORE_CASE
)

data class SanitizeResult(val ok: Boolean, val text: String, val reason: String? = null)

/**
 * Guard rails for the model output. The failure mode we care about is the model treating the
 * dictation as a question and answering it, or wrapping the result in commentary. Anything
 * rejected here makes the caller fall back to the deterministic pipeline output.
 */
fun sanitizeLlmOutput(output: String, raw: String): SanitizeResult {
    var text = output.replace(Regex("\\r\\n?"), "\n").trim()
    text = Regex("^```[a-z]*\\n?([\\s\\S]*?)\\n?```$", RegexOption.IGNORE_CASE)
        .replace(text) { it.groupValues[1] }.trim()
    if (Regex("^[\"“”'][\\s\\S]*[\"“”']$").matches(text) &&
        !Regex("^[\"“”']").containsMatchIn(raw.trim())
    ) {
        text = text.substring(1, text.length - 1).trim()
    }
    text = LABEL_PREFIX.replace(text, "").trim()

    if (text.isEmpty()) return SanitizeResult(false, "", "empty")
    val rawTrim = raw.trim()
    if (CHATTY_PREFIX.containsMatchIn(text) && !CHATTY_PREFIX.containsMatchIn(rawTrim)) {
        return SanitizeResult(false, text, "chatty")
    }

    val rawWords = countWords(raw)
    val outWords = countWords(text)
    if (rawWords >= 6) {
        val ratio = outWords.toDouble() / rawWords
        if (ratio < 0.35) return SanitizeResult(false, text, "too-short")
        if (ratio > 2.2) return SanitizeResult(false, text, "too-long")
    } else if (outWords > rawWords + 6) {
        return SanitizeResult(false, text, "too-long")
    }

    // A dictated question must still be a question; an answer is the classic failure.
    if (QUESTION_START.containsMatchIn(rawTrim) && rawWords >= 3 && !text.contains('?')) {
        if (!QUESTION_START.containsMatchIn(text)) return SanitizeResult(false, text, "answered")
    }

    // The rewrite must share most of its content words with the transcript.
    if (rawWords >= 5) {
        val rawSet = contentWords(raw)
        val outSet = contentWords(text)
        if (rawSet.size >= 3 && outSet.isNotEmpty()) {
            var shared = 0
            for (w in outSet) if (w in rawSet) shared++
            val overlap = shared.toDouble() / outSet.size
            if (overlap < 0.45) return SanitizeResult(false, text, "diverged")
        }
    }
    return SanitizeResult(true, text)
}

private fun contentWords(s: String): Set<String> {
    val out = HashSet<String>()
    for (m in Regex("[\\p{L}\\p{N}']+").findAll(s.lowercase())) {
        val w = m.value
        if (w.length >= 3) out.add(w.trim('\''))
    }
    return out
}

/**
 * Upper bound for completion tokens. Reasoning models spend hidden tokens before answering, so
 * this is a runaway guard rather than a budget.
 */
fun maxTokensFor(raw: String, multiplier: Double = 2.0): Int {
    val words = countWords(raw)
    return minOf(4096, maxOf(768, Math.ceil(words * 1.6 * multiplier).toInt() + 512))
}

/** STT prompt hint built from the custom dictionary, mirroring the desktop behaviour. */
fun buildSttPrompt(terms: List<String>): String? {
    val clean = terms.map { it.trim() }.filter { it.isNotEmpty() }.take(60)
    if (clean.isEmpty()) return null
    return "Glossary: ${clean.joinToString(", ")}."
}
