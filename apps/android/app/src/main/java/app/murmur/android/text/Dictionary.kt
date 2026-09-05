package app.murmur.android.text

import app.murmur.android.settings.DictionaryEntry

/**
 * Enforce dictionary spellings, mirroring apps/desktop/src/core/text/dictionary.ts: an exact
 * (case-insensitive) match of a word or any alias becomes the canonical spelling, then a fuzzy pass
 * fixes near-misses for entries that opted in or for capitalized tokens (probable names).
 */
fun applyDictionary(text: String, entries: List<DictionaryEntry>): String {
    if (entries.isEmpty() || text.isEmpty()) return text
    val canonical = LinkedHashMap<String, String>()
    val fuzzyTerms = ArrayList<Triple<String, String, Boolean>>() // term, canonical, fuzzy
    val allLower = HashSet<String>()
    for (e in entries) {
        val word = e.word.trim()
        if (word.isEmpty()) continue
        allLower.add(word.lowercase())
        for (variant in listOf(word) + e.aliases) {
            val v = variant.trim()
            if (v.isEmpty()) continue
            val key = v.lowercase().replace(Regex("\\s+"), " ")
            canonical.putIfAbsent(key, word)
            if (!v.contains(Regex("\\s"))) fuzzyTerms.add(Triple(key, word, e.fuzzy))
        }
    }
    var out = text
    if (canonical.isNotEmpty()) {
        // Regex.escape uses \Q...\E quoting on the JVM, so whitespace must be handled per token.
        val alternation = canonical.keys
            .sortedByDescending { it.length }
            .joinToString("|") { key -> key.split(' ').joinToString("\\s+") { escapeRegex(it) } }
        val re = Regex("(?<![\\p{L}\\p{N}])(?:$alternation)(?![\\p{L}\\p{N}'’-])", RegexOption.IGNORE_CASE)
        out = re.replace(out) { m ->
            canonical[m.value.lowercase().replace(Regex("\\s+"), " ")] ?: m.value
        }
    }
    if (fuzzyTerms.isNotEmpty()) {
        val token = Regex("[\\p{L}][\\p{L}\\p{N}'’-]{3,}")
        out = token.replace(out) { m ->
            val lower = m.value.lowercase()
            if (allLower.contains(lower) || canonical.containsKey(lower)) return@replace m.value
            val capitalized = m.value.first().isUpperCase()
            var best: Pair<String, Int>? = null
            for ((term, canon, fuzzy) in fuzzyTerms) {
                if (!fuzzy && !capitalized) continue
                if (kotlin.math.abs(term.length - lower.length) > 2) continue
                val maxD = if (term.length >= 8) 2 else 1
                val d = editDistance(lower, term, maxD)
                if (d <= maxD && (best == null || d < best.second)) best = canon to d
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
