package app.murmur.android.text

import app.murmur.android.settings.DictionaryEntry
import java.text.Normalizer

/**
 * Enforce dictionary spellings, mirroring packages/text-engine/src/dictionary.ts. The dictionary
 * is a plain list the formatting model reads; the rules only do the exact part: a word in any
 * casing gets the dictionary's casing, and a recorded mis-hearing (an alias, usually learned from
 * one of the user's corrections) becomes the word. Nothing is guessed by sound or spelling.
 */

private class Compiled(val exact: Regex?, val canonical: Map<String, String>)

private val LATIN = Regex("^[a-z'’-]+$")
private val NON_LETTER = Regex("[^a-z]")
private val MARKS = Regex("\\p{M}+")

/**
 * The engine's word boundary (text.ts `WB_START` / `WB_END`): letters, digits and the underscore
 * continue a word, everything else ends it. An apostrophe or a hyphen therefore closes the match,
 * so a term or alias is corrected inside its possessive ("bennet's" → "Bennett's", with either
 * apostrophe) and as the first half of a hyphenated name, while an identifier ("bennet_id") is one
 * word and is left alone.
 */
private const val WB_START = "(?<![\\p{L}\\p{N}_])"
private const val WB_END = "(?![\\p{L}\\p{N}_])"

/**
 * A rough sound key for a Latin-script word, in the spirit of Metaphone: what it sounds like
 * rather than how it is spelt, so "whisper" and "Wispr", "Bennet" and "Bennett", "Konvex" and
 * "Convex" collide. Vowels after the first are dropped, doubled letters collapsed, common
 * digraphs and silent letters folded. Non-Latin words come back unchanged apart from casing.
 */
fun soundKey(word: String): String {
    val lower = MARKS.replace(Normalizer.normalize(word, Normalizer.Form.NFD), "").lowercase()
    if (!LATIN.matches(lower)) return lower.replace(Regex("[^\\p{L}\\p{N}]"), "")
    var w = NON_LETTER.replace(lower, "")
    if (w.isEmpty()) return ""
    w = w.replace(Regex("^(?:kn|gn|pn|wr)")) { it.value.substring(1) }
    w = w.replace(Regex("^x"), "s").replace(Regex("^wh"), "w")
    w = w.replace("ph", "f")
    w = w.replace("tch", "ch").replace("sch", "sk").replace("ch", "x").replace("sh", "x")
    w = w.replace("th", "0")
    w = w.replace(Regex("gh(?![aeiou])"), "").replace("dg", "j").replace("ck", "k")
    w = w.replace("q", "k").replace("x", "ks").replace("z", "s")
    w = w.replace(Regex("c(?=[eiy])"), "s").replace("c", "k")
    w = w.replace(Regex("mb$"), "m")
    w = w.replace(Regex("[wy](?![aeiou])"), "")
    w = w.replace("v", "f").replace("d", "t")
    w = w.replace(Regex("(.)\\1+"), "$1")
    if (w.isEmpty()) return ""
    return w.substring(0, 1) + w.substring(1).replace(Regex("[aeiouy]"), "")
}

/** The first vowel sound of a word: the one piece of vowel information the sound key keeps. */
fun firstVowel(word: String): String {
    val m = Regex("[aeiouy]").find(word.lowercase()) ?: return ""
    return if (m.value == "y") "i" else m.value
}

private fun compile(entries: List<DictionaryEntry>): Compiled {
    val canonical = LinkedHashMap<String, String>()
    for (e in entries) {
        val word = e.word.trim()
        if (word.isEmpty()) continue
        for (variant in listOf(word) + e.aliases) {
            val key = variant.trim().lowercase().replace(Regex("\\s+"), " ")
            if (key.isNotEmpty()) canonical.putIfAbsent(key, word)
        }
    }
    val exact = if (canonical.isEmpty()) null else {
        // Regex.escape uses \Q...\E quoting on the JVM, so whitespace must be handled per token.
        val alternation = canonical.keys
            .sortedByDescending { it.length }
            .joinToString("|") { key -> key.split(' ').joinToString("\\s+") { escapeRegex(it) } }
        Regex("$WB_START(?:$alternation)$WB_END", RegexOption.IGNORE_CASE)
    }
    return Compiled(exact, canonical)
}

fun applyDictionary(text: String, entries: List<DictionaryEntry>): String {
    if (entries.isEmpty() || text.isEmpty()) return text
    val c = compile(entries)
    val re = c.exact ?: return text
    return re.replace(text) { m -> c.canonical[m.value.lowercase().replace(Regex("\\s+"), " ")] ?: m.value }
}

/** Damerau-Levenshtein distance (optimal string alignment) with an early exit once `max` is exceeded, as text.ts. */
fun editDistance(a: String, b: String, max: Int): Int {
    if (a == b) return 0
    if (kotlin.math.abs(a.length - b.length) > max) return max + 1
    if (a.isEmpty()) return b.length
    if (b.isEmpty()) return a.length
    var prev2 = IntArray(b.length + 1)
    var prev = IntArray(b.length + 1) { it }
    for (i in 1..a.length) {
        val cur = IntArray(b.length + 1)
        cur[0] = i
        var rowMin = i
        for (j in 1..b.length) {
            val cost = if (a[i - 1] == b[j - 1]) 0 else 1
            var v = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) v = minOf(v, prev2[j - 2] + 1)
            cur[j] = v
            if (v < rowMin) rowMin = v
        }
        if (rowMin > max) return max + 1
        prev2 = prev
        prev = cur
    }
    return prev[b.length]
}
