package app.murmur.android.text

import app.murmur.android.settings.DictionaryEntry
import java.text.Normalizer

/**
 * Enforce dictionary spellings, mirroring apps/desktop/src/core/text/dictionary.ts: an exact
 * (case-insensitive) match of a word or any alias becomes the canonical spelling, multi-word terms
 * are matched by sound however the recognizer split or spelt them, then a fuzzy pass fixes
 * single-word near-misses (by spelling or by sound) for entries that opted in or for capitalized
 * tokens (probable names).
 */

private class FuzzyTerm(val term: String, val canonical: String, val fuzzy: Boolean) {
    val key = soundKey(term)
    val vowel = firstVowel(term)
}

private class PhraseTerm(val canonical: String, val words: List<String>, val fuzzy: Boolean) {
    val key = phraseKey(words)
    val vowel = firstVowel(words.joinToString(""))
}

private class Compiled(
    val exact: Regex?,
    val canonical: Map<String, String>,
    val fuzzyTerms: List<FuzzyTerm>,
    val phrases: List<PhraseTerm>,
    val allLower: Set<String>
)

private val LATIN = Regex("^[a-z'’-]+$")
private val NON_LETTER = Regex("[^a-z]")
private val MARKS = Regex("\\p{M}+")

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
private fun firstVowel(word: String): String {
    val m = Regex("[aeiouy]").find(word.lowercase()) ?: return ""
    return if (m.value == "y") "i" else m.value
}

private fun phraseKey(words: List<String>): String = words.joinToString("") { soundKey(it) }

private fun compile(entries: List<DictionaryEntry>): Compiled {
    val canonical = LinkedHashMap<String, String>()
    val fuzzyTerms = ArrayList<FuzzyTerm>()
    val phrases = ArrayList<PhraseTerm>()
    val allLower = HashSet<String>()
    for (e in entries) {
        val word = e.word.trim()
        if (word.isEmpty()) continue
        allLower.add(word.lowercase())
        // The words of a canonical spelling are final; the fuzzy pass must not touch them.
        for (part in word.lowercase().split(Regex("[\\s-]+"))) if (part.isNotEmpty()) allLower.add(part)
        for (variant in listOf(word) + e.aliases) {
            val v = variant.trim()
            if (v.isEmpty()) continue
            val key = v.lowercase().replace(Regex("\\s+"), " ")
            canonical.putIfAbsent(key, word)
            val words = key.split(Regex("[\\s-]+")).filter { it.isNotEmpty() }
            if (words.size == 1) {
                fuzzyTerms.add(FuzzyTerm(key, word, e.fuzzy))
            } else if (words.size <= 5) {
                val phrase = PhraseTerm(word, words, e.fuzzy)
                // Too little sound to go on ("Go To" is just "gt"); exact and alias matching still apply.
                if (phrase.key.length >= 4) phrases.add(phrase)
            }
        }
    }
    val exact = if (canonical.isEmpty()) null else {
        // Regex.escape uses \Q...\E quoting on the JVM, so whitespace must be handled per token.
        val alternation = canonical.keys
            .sortedByDescending { it.length }
            .joinToString("|") { key -> key.split(' ').joinToString("\\s+") { escapeRegex(it) } }
        Regex("(?<![\\p{L}\\p{N}])(?:$alternation)(?![\\p{L}\\p{N}'’-])", RegexOption.IGNORE_CASE)
    }
    phrases.sortWith(compareByDescending<PhraseTerm> { it.words.size }.thenByDescending { it.key.length })
    return Compiled(exact, canonical, fuzzyTerms, phrases, allLower)
}

/** Same sound and the same first vowel: a mis-spelling or mis-hearing of the term. */
private fun soundsLike(key: String, vowel: String, termKey: String, termVowel: String, allowNear: Boolean): Boolean {
    if (key.isEmpty() || termKey.isEmpty() || vowel != termVowel) return false
    if (key == termKey) return true
    if (!allowNear || termKey.length < 5) return false
    return kotlin.math.abs(key.length - termKey.length) <= 1 && editDistance(key, termKey, 1) <= 1
}

private class Token(val text: String, val start: Int, val end: Int)

private val TOKEN_RE = Regex("[\\p{L}\\p{N}][\\p{L}\\p{N}'’-]*")

/**
 * Multi-word terms: "Wispr Flow" comes back from the recognizer as "whisper flow", "Whisper Flo"
 * or "whisperflow". Windows of n-1..n+1 words are compared by sound; a matching window becomes
 * the canonical spelling. An exact sound match is trusted for every entry; a near match needs
 * the same word count and either a fuzzy entry or a window capitalized like a name.
 */
private fun applyPhrases(text: String, c: Compiled): String {
    if (c.phrases.isEmpty()) return text
    val tokens = TOKEN_RE.findAll(text).map { Token(it.value, it.range.first, it.range.last + 1) }.toList()
    if (tokens.isEmpty()) return text
    val tokenKeys = tokens.map { soundKey(it.text) }
    val taken = BooleanArray(tokens.size)
    // Words that already spell a term (or an alias) are final; no window may swallow them.
    c.exact?.findAll(text)?.forEach { m ->
        val from = m.range.first
        val to = m.range.last + 1
        tokens.forEachIndexed { i, t -> if (t.start >= from && t.end <= to) taken[i] = true }
    }
    data class Match(val start: Int, val end: Int, val replacement: String)
    val matches = ArrayList<Match>()
    for (phrase in c.phrases) {
        val n = phrase.words.size
        for (size in listOf(n, n - 1, n + 1)) {
            if (size < 1 || size > tokens.size) continue
            // A merged or split rendering ("whisperflow", "wisp or flow") needs a longer sound to match.
            if (size != n && phrase.key.length < 5) continue
            var i = 0
            while (i + size <= tokens.size) {
                val window = tokens.subList(i, i + size)
                val free = (i until i + size).none { taken[it] }
                val contiguous = (i + 1 until i + size).all { k ->
                    Regex("^[\\s-]*$").matches(text.substring(tokens[k - 1].end, tokens[k].start))
                }
                if (free && contiguous) {
                    val joined = window.joinToString(" ") { it.text }.lowercase().replace(Regex("\\s+"), " ")
                    if (joined != phrase.canonical.lowercase() && !c.canonical.containsKey(joined)) {
                        val letters = window.joinToString("") { it.text }
                        val key = tokenKeys.subList(i, i + size).joinToString("")
                        val capitalized = window.any { it.text.first().isUpperCase() }
                        val allowNear = size == n && (phrase.fuzzy || capitalized)
                        if (soundsLike(key, firstVowel(letters), phrase.key, phrase.vowel, allowNear)) {
                            matches.add(Match(window.first().start, window.last().end, phrase.canonical))
                            for (k in i until i + size) taken[k] = true
                        }
                    }
                }
                i++
            }
        }
    }
    if (matches.isEmpty()) return text
    matches.sortBy { it.start }
    val out = StringBuilder()
    var pos = 0
    for (m in matches) {
        out.append(text, pos, m.start).append(m.replacement)
        pos = m.end
    }
    out.append(text, pos, text.length)
    return out.toString()
}

fun applyDictionary(text: String, entries: List<DictionaryEntry>): String {
    if (entries.isEmpty() || text.isEmpty()) return text
    val c = compile(entries)
    var out = text
    c.exact?.let { re ->
        out = re.replace(out) { m -> c.canonical[m.value.lowercase().replace(Regex("\\s+"), " ")] ?: m.value }
    }
    out = applyPhrases(out, c)
    if (c.fuzzyTerms.isNotEmpty()) {
        val token = Regex("[\\p{L}][\\p{L}\\p{N}'’-]{3,}")
        out = token.replace(out) { m ->
            val lower = m.value.lowercase()
            if (c.allLower.contains(lower) || c.canonical.containsKey(lower)) return@replace m.value
            val capitalized = m.value.first().isUpperCase()
            val key = soundKey(lower)
            val vowel = firstVowel(lower)
            var best: Pair<String, Double>? = null
            for (t in c.fuzzyTerms) {
                if (!t.fuzzy && !capitalized) continue
                var d = Double.POSITIVE_INFINITY
                if (kotlin.math.abs(t.term.length - lower.length) <= 2) {
                    val maxD = if (t.term.length >= 8) 2 else 1
                    val spelling = editDistance(lower, t.term, maxD)
                    if (spelling <= maxD) d = spelling.toDouble()
                }
                if (d > 1 && t.term.length >= 4 && soundsLike(key, vowel, t.key, t.vowel, true)) {
                    d = minOf(d, if (key == t.key) 0.5 else 1.5)
                }
                if (d != Double.POSITIVE_INFINITY && (best == null || d < best.second)) best = t.canonical to d
            }
            best?.first ?: m.value
        }
    }
    return out
}

/** Levenshtein distance with an early exit once `max` is exceeded. */
fun editDistance(a: String, b: String, max: Int): Int {
    if (a == b) return 0
    if (kotlin.math.abs(a.length - b.length) > max) return max + 1
    var prev = IntArray(b.length + 1) { it }
    var curr = IntArray(b.length + 1)
    for (i in 1..a.length) {
        curr[0] = i
        var rowMin = curr[0]
        for (j in 1..b.length) {
            val cost = if (a[i - 1] == b[j - 1]) 0 else 1
            curr[j] = minOf(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
            if (curr[j] < rowMin) rowMin = curr[j]
        }
        if (rowMin > max) return max + 1
        val tmp = prev
        prev = curr
        curr = tmp
    }
    return prev[b.length]
}
