package app.murmur.android.text

import app.murmur.android.settings.DictionaryEntry
import java.text.Normalizer

/**
 * Learning from the user's own corrections, ported from packages/text-engine/src/corrections.ts
 * and pinned to it by the golden file: Murmur typed "whisper flow", the user changed it to "Wispr
 * Flow", so Murmur offers to add "Wispr Flow" to the dictionary with "whisper flow" as how the
 * speech model hears it. This file only judges an edit; the accessibility service sees it.
 */

data class WordCorrection(
    /** What Murmur typed. */
    val heard: String,
    /** What the user changed it to: the dictionary spelling. */
    val word: String,
    /** "add": not in the dictionary yet. "alias": it is, but this mis-hearing is new. */
    val kind: String
)

data class EditedSpan(val original: String, val edited: String)

private val COMMON: Set<String> = """
  a about above after again against all also am an and any are as at be because been before
  being below between both but by can could did do does doing done down during each few for from
  further get got had has have having he her here hers herself him himself his how i if in into is
  it its itself just let like make me more most my myself no nor not now of off on once only or
  other our ours ourselves out over own same say said see she should so some such than that the
  their theirs them themselves then there these they this those through to too under until up us
  very was we were what when where which while who whom why will with would you your yours
  yourself yourselves one two three four five six seven eight nine ten first last next new old
  good great little big long high right left well way day time year people thing things man
  woman know think go going come came take took give gave tell told ask work call try need feel
  become leave put mean keep begin seem help show hear play run move live believe bring happen
  write sit stand lose pay meet include continue set learn change lead understand watch follow
  stop create speak read spend grow open walk win offer remember love consider appear buy wait
  serve die send expect build stay fall cut reach kill remain much many still even back there's
  it's i'm don't can't won't isn't aren't wasn't weren't didn't doesn't that's what's let's
  we're they're you're i've we've you've i'd we'd you'd i'll we'll you'll okay ok yes yeah hey
  hi thanks thank please sorry maybe really actually probably today tomorrow yesterday week
  month here's where's who's quite though although whether else ever never always sometimes
  often already yet soon later around away anything something nothing everything someone
  anyone everyone today's an the
""".split(Regex("\\s+")).filter { it.isNotEmpty() }.toSet()

private class Tok(val text: String, val start: Int, val end: Int)

private val CORRECTION_TOKEN = Regex("[\\p{L}\\p{N}](?:[\\p{L}\\p{N}'’_.-]*[\\p{L}\\p{N}])?")
private val NOT_A_WORD_CHARS = Regex("[/\\\\@:_#=<>{}\\[\\]()*`|~^$%&+]")
private val HEX_ID = Regex("^[0-9a-f]{7,}$", RegexOption.IGNORE_CASE)
private val DIGIT = Regex("\\d")
private val NUMBER_CHAR = Regex("\\p{N}")
private val LETTER_CHAR = Regex("\\p{L}")
private val NON_ALNUM = Regex("[^\\p{L}\\p{N}]")
private val COMBINING = Regex("[\\u0300-\\u036f]")
private val WORD_CHAR = Regex("[\\p{L}\\p{N}'’_.-]")
private val SPACES = Regex("\\s+")

private const val MAX_HUNK_WORDS = 3
private const val MAX_SUGGESTIONS = 3
private const val MAX_DIFF_WORDS = 300

private fun tokenize(text: String): List<Tok> =
    CORRECTION_TOKEN.findAll(text).map { Tok(it.value, it.range.first, it.range.last + 1) }.toList()

private class Hunk(val removed: MutableList<Tok> = ArrayList(), val added: MutableList<Tok> = ArrayList())

private fun diffWords(a: List<Tok>, b: List<Tok>): List<Hunk>? {
    var head = 0
    while (head < a.size && head < b.size && a[head].text == b[head].text) head++
    var tail = 0
    while (tail < a.size - head && tail < b.size - head && a[a.size - 1 - tail].text == b[b.size - 1 - tail].text) tail++
    val x = a.subList(head, a.size - tail)
    val y = b.subList(head, b.size - tail)
    if (x.isEmpty() && y.isEmpty()) return emptyList()
    if (x.size > MAX_DIFF_WORDS || y.size > MAX_DIFF_WORDS) return null
    val n = x.size
    val m = y.size
    val lcs = Array(n + 1) { IntArray(m + 1) }
    for (i in n - 1 downTo 0) for (j in m - 1 downTo 0)
        lcs[i][j] = if (x[i].text == y[j].text) lcs[i + 1][j + 1] + 1 else maxOf(lcs[i + 1][j], lcs[i][j + 1])
    val hunks = ArrayList<Hunk>()
    var cur = Hunk()
    fun flush() {
        if (cur.removed.isNotEmpty() || cur.added.isNotEmpty()) hunks.add(cur)
        cur = Hunk()
    }
    var i = 0
    var j = 0
    while (i < n || j < m) {
        if (i < n && j < m && x[i].text == y[j].text) {
            flush(); i++; j++
        } else if (j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j])) cur.added.add(y[j++])
        else cur.removed.add(x[i++])
    }
    flush()
    return hunks
}

private fun letters(s: String): String =
    NON_ALNUM.replace(COMBINING.replace(Normalizer.normalize(s, Normalizer.Form.NFD), "").lowercase(), "")

private fun isCommon(word: String): Boolean =
    word.split(SPACES).all { COMMON.contains(it.lowercase().replace('’', '\'')) }

private fun notAWord(word: String): Boolean {
    if (NOT_A_WORD_CHARS.containsMatchIn(word)) return true
    if (HEX_ID.matches(word) && DIGIT.containsMatchIn(word)) return true
    return NUMBER_CHAR.findAll(word).count() > LETTER_CHAR.findAll(word).count()
}

private fun resembles(heard: String, word: String): Boolean {
    val a = letters(heard)
    val b = letters(word)
    if (a.isEmpty() || b.isEmpty()) return false
    if (a == b) return true
    val keyA = heard.split(SPACES).joinToString("") { soundKey(it) }
    val keyB = word.split(Regex("[\\s.-]+")).joinToString("") { soundKey(it) }
    if (keyA.length >= 2 && keyA == keyB) return true
    val longest = maxOf(a.length, b.length)
    if (longest < 3) return false
    val allowed = if (longest <= 4) 1 else maxOf(1, (longest * 0.4).toInt())
    return editDistance(a, b, allowed) <= allowed
}

/** The dictionary-worthy corrections in one edit of text Murmur typed (corrections.ts `findCorrections`). */
fun findCorrections(original: String, edited: String, dictionary: List<DictionaryEntry> = emptyList()): List<WordCorrection> {
    val before = tokenize(original)
    val after = tokenize(edited)
    if (before.isEmpty() || after.isEmpty()) return emptyList()
    val hunks = diffWords(before, after) ?: return emptyList()
    if (hunks.isEmpty()) return emptyList()
    val changed = hunks.sumOf { maxOf(it.removed.size, it.added.size) }
    if (before.size >= 4 && changed > before.size / 2.0) return emptyList()

    val byWord = HashMap<String, DictionaryEntry>()
    val byVariant = HashMap<String, DictionaryEntry>()
    for (d in dictionary) {
        val w = d.word.trim().lowercase()
        if (w.isEmpty()) continue
        byWord[w] = d
        byVariant[w] = d
        for (a in d.aliases) if (a.isNotBlank()) byVariant[a.trim().lowercase()] = d
    }

    val out = ArrayList<WordCorrection>()
    val seen = HashSet<String>()
    for (h in hunks) {
        if (h.removed.isEmpty() || h.added.isEmpty()) continue
        if (h.removed.size > MAX_HUNK_WORDS || h.added.size > MAX_HUNK_WORDS) continue
        val heard = h.removed.joinToString(" ") { it.text }
        val word = edited.substring(h.added.first().start, h.added.last().end).trim()
        if (!LETTER_CHAR.containsMatchIn(word) || word.length < 2 || word.length > 60) continue
        if (notAWord(word)) continue
        val heardLower = heard.lowercase()
        val wordLower = word.lowercase()
        if (wordLower in seen) continue
        if (heardLower == wordLower.replace(SPACES, " ")) {
            if (word == word.lowercase() || isCommon(word)) continue
            if (byWord[wordLower]?.word == word) continue
            seen.add(wordLower)
            out.add(WordCorrection(heard, word, if (byWord.containsKey(wordLower)) "alias" else "add"))
        } else {
            if (isCommon(word) && word == word.lowercase()) continue
            if (!resembles(heard, word)) continue
            val entry = byWord[wordLower]
            if (entry != null) {
                if (byVariant[heardLower] === entry) continue
                if (byWord.containsKey(heardLower)) continue
                seen.add(wordLower)
                out.add(WordCorrection(heard, entry.word, "alias"))
            } else {
                seen.add(wordLower)
                out.add(WordCorrection(heard, word, "add"))
            }
        }
        if (out.size >= MAX_SUGGESTIONS) break
    }
    return out
}

/** Where the user edited the dictation inside a field (corrections.ts `editedSpan`). */
fun editedSpan(before: String, after: String, start: Int, end: Int): EditedSpan? {
    if (before == after) return null
    if (start < 0 || end > before.length || start >= end) return null
    var p = 0
    val maxP = minOf(before.length, after.length)
    while (p < maxP && before[p] == after[p]) p++
    var s = 0
    while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] == after[after.length - 1 - s]) s++
    val changeStart = p
    val changeEnd = before.length - s
    if (changeEnd <= start || changeStart >= end) {
        if (!(changeStart == changeEnd && changeStart > start && changeStart < end)) return null
    }
    fun isWord(i: Int): Boolean = i in before.indices && WORD_CHAR.matches(before[i].toString())
    var from = minOf(start, changeStart)
    var to = maxOf(end, changeEnd)
    while (from > 0 && isWord(from - 1)) from--
    while (to < before.length && isWord(to)) to++
    val delta = after.length - before.length
    return EditedSpan(before.substring(from, to), after.substring(from, to + delta))
}
