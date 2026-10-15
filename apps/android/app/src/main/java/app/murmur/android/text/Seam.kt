package app.murmur.android.text

/**
 * Joining pieces of a long dictation that were transcribed and formatted separately, ported from
 * packages/text-engine/src/seam.ts (kept in step by SeamTest). A piece ends wherever the speaker
 * paused, often mid-sentence, and comes back with a period and a capital at the cut, sometimes
 * with the word at the cut heard twice. joinSeam repairs that one boundary.
 */
private val SEAM_WORD = Regex("""[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*""")

private val CONTINUATION: Set<String> = (
    "a an the as of to and or but nor so if than that which who whose with without for from in " +
        "on at by into onto about over under after before between through during like my your our " +
        "their his her its this these those some any every each very really literally just quite " +
        "almost also would could should will can may might must shall is are was were be been being " +
        "am do does did have has had not because since while when where whether although though " +
        "until unless even more most less such we they he she i'm we're they're you're i've we've " +
        "they've i'd we'd they'd i'll we'll they'll it's there's that's gonna wanna gotta kind sort " +
        "whatever whichever whoever both either neither"
    ).split(Regex("\\s+")).toSet()

private val ARTICLES = setOf("a", "an", "the")
private val ALWAYS_CAPITAL = Regex("""^(I|I['’](m|ll|ve|d))$""")

private data class SeamWord(val key: String, val start: Int, val end: Int, val text: String)

private fun seamWords(s: String): List<SeamWord> = SEAM_WORD.findAll(s).map {
    SeamWord(it.value.lowercase().replace('’', '\''), it.range.first, it.range.last + 1, it.value)
}.toList()

/** Words searched each side of a seam for a repeat; mirrors SEAM_WINDOW in seam.ts. */
const val SEAM_WINDOW = 20
private const val ECHO_SLACK = 3
private val CONTRACTION_END = Regex("""'(s|re|ll|ve|d|m|t)$""")

/** Same word, or the same word with and without a contraction ("it" / "it's"). */
private fun sameKey(a: String, b: String): Boolean {
    if (a == b) return true
    return minOf(a.length, b.length) >= 2 && a.replace(CONTRACTION_END, "") == b.replace(CONTRACTION_END, "")
}

/** Does [b] start with the [k] words of [a] ending at [aEnd] (exclusive)? Mirrors runMatches in seam.ts. */
private fun runMatches(a: List<SeamWord>, aEnd: Int, b: List<SeamWord>, k: Int): Boolean {
    if (k <= 0 || k > aEnd || k > b.size) return false
    val from = aEnd - k
    if (!sameKey(a[from].key, b[0].key) || a[aEnd - 1].key != b[k - 1].key) return false
    var miss = 0
    val allowed = if (k >= 8) 1 else 0
    for (i in 0 until k) {
        val same = if (k >= 4) sameKey(a[from + i].key, b[i].key) else a[from + i].key == b[i].key
        if (!same && ++miss > allowed) return false
    }
    return true
}

private data class Repeat(val k: Int, val slack: Int)

private fun findRepeat(hw: List<SeamWord>, tw: List<SeamWord>): Repeat? {
    for (k in minOf(hw.size, tw.size) downTo 1) {
        if (runMatches(hw, hw.size, tw, k) && (k >= 2 || tw[0].key.length >= 4 || tw[0].key in CONTINUATION)) return Repeat(k, 0)
    }
    for (slack in 1..ECHO_SLACK) {
        var k = minOf(hw.size - slack, tw.size)
        while (k >= 5) {
            if (runMatches(hw, hw.size - slack, tw, k)) return Repeat(k, slack)
            k--
        }
    }
    return null
}

data class SeamJoin(val text: String, val deduped: Int, val joined: Boolean)

private fun looksLikeName(word: String, vararg texts: String): Boolean {
    if (word.length > 1 && word == word.uppercase()) return true
    val re = Regex("""[\p{L}\p{N},;:]\s+${Regex.escape(word)}\b""")
    return texts.any { re.containsMatchIn(it) }
}

fun joinSeam(prev: String, next: String): SeamJoin {
    var h = prev.trimEnd()
    var t = next.trimStart()
    if (t.isEmpty()) return SeamJoin(h, 0, false)
    if (h.isEmpty()) return SeamJoin(t, 0, false)

    val hw = seamWords(h).takeLast(SEAM_WINDOW)
    var tw = seamWords(t).take(SEAM_WINDOW)
    var deduped = 0
    val rep = findRepeat(hw, tw)
    val slackRep = rep != null && rep.slack > 0
    if (rep != null && rep.slack > 0) {
        val slackWords = hw.subList(hw.size - rep.slack, hw.size)
        val after = tw.drop(rep.k).take(rep.slack)
        val redone = after.size == rep.slack && slackWords.indices.all { sameKey(slackWords[it].key, after[it].key) }
        if (redone) h = h.substring(0, slackWords[0].start).replace(Regex("""[\s,;:]+$"""), "")
        t = t.substring(tw[rep.k - 1].end).replace(Regex("""^[\s,;:.!?…-]+"""), "")
        deduped = rep.k
        if (t.isEmpty()) return SeamJoin(h, deduped, false)
        tw = seamWords(t).take(SEAM_WINDOW)
    } else if (rep != null) deduped = rep.k
    val lastH = hw.lastOrNull()
    if (deduped == 0 && lastH != null && tw.isNotEmpty() && lastH.key in ARTICLES && tw[0].key in ARTICLES) {
        h = h.substring(0, lastH.start).trimEnd()
        val startsSentence = h.isEmpty() || Regex("""[.!?…]["')\]]*$""").containsMatchIn(h)
        if (!startsSentence) t = tw[0].text.lowercase() + t.substring(tw[0].end)
        if (h.isEmpty()) return SeamJoin(t, 1, false)
        deduped = 1
        tw = seamWords(t).take(SEAM_WINDOW)
    } else if (deduped > 0 && !slackRep) {
        t = t.substring(tw[deduped - 1].end).replace(Regex("""^[\s,;:.!?…-]+"""), "")
        if (t.isEmpty()) return SeamJoin(h, deduped, false)
        tw = seamWords(t).take(SEAM_WINDOW)
    }

    val last = seamWords(h).lastOrNull()
    val first = tw.firstOrNull()
    val endsSoft = Regex("""(\.{2,}|…|(?<!\.)\.)["')\]]*$""").containsMatchIn(h) && !Regex("""[!?]["')\]]*$""").containsMatchIn(h)
    val endsBare = !Regex("""[.!?…:;,"')\]]$""").containsMatchIn(h)
    val firstAtStart = first != null && first.start == 0
    val nextLower = firstAtStart && first!!.text[0].isLowerCase()
    val midSentence = deduped > 0 || Regex("""(\.{2,}|…)["')\]]*$""").containsMatchIn(h) ||
        (last != null && last.key in CONTINUATION) || nextLower
    var joined = false
    if (firstAtStart && midSentence && (endsSoft || endsBare)) {
        if (endsSoft) h = h.replace(Regex("""(\.{2,}|…|\.)(["')\]]*)$"""), "$2")
        val f = first!!
        val keepCap = ALWAYS_CAPITAL.matches(f.text) || looksLikeName(f.text, h, t.substring(f.end))
        if (!keepCap) t = f.text.lowercase() + t.substring(f.end)
        joined = endsSoft || !keepCap
    } else if (firstAtStart && endsBare && !midSentence && first!!.text[0].isUpperCase() &&
        !ALWAYS_CAPITAL.matches(first.text) && !looksLikeName(first.text, h, t.substring(first.end))
    ) {
        // A bare end followed by a capital that is not a name or "I": the piece left off a period.
        h = "$h."
    }
    return SeamJoin("$h $t", deduped, joined)
}

data class PiecesJoin(val text: String, val deduped: Int, val joined: Int)

fun joinPieces(pieces: List<String>): PiecesJoin {
    var text = ""
    var deduped = 0
    var joined = 0
    for (p in pieces) {
        if (p.isBlank()) continue
        val j = joinSeam(text, p)
        text = j.text
        deduped += j.deduped
        if (j.joined) joined++
    }
    return PiecesJoin(text.trim(), deduped, joined)
}

/** The end of the piece before, from its last sentence start, at most [maxWords] words. */
fun seamContext(prev: String, maxWords: Int = 12): String {
    val t = prev.trim()
    if (t.isEmpty()) return ""
    val tail = t.substring(lastSentenceStart(t))
    val ws = seamWords(tail)
    return if (ws.size <= maxWords) tail else tail.substring(ws[ws.size - maxWords].start)
}

/** A formatted piece that starts by copying its context loses the copy (3+ matching words). */
fun stripEcho(output: String, before: String): String {
    val bw = seamWords(before).takeLast(SEAM_WINDOW)
    val ow = seamWords(output)
    if (bw.size < 3 || ow.size <= 3) return output
    fun cut(k: Int) = output.substring(ow[k - 1].end).replace(Regex("""^[\s,;:.!?…-]+"""), "")
    for (k in minOf(bw.size, ow.size - 1) downTo 3) if (runMatches(bw, bw.size, ow, k)) return cut(k)
    for (slack in 1..ECHO_SLACK) {
        var k = minOf(bw.size - slack, ow.size - 1)
        while (k >= 5) {
            if (runMatches(bw, bw.size - slack, ow, k)) return cut(k)
            k--
        }
    }
    return output
}

/** Where the last (or unfinished) sentence of [text] starts; mirrors lastSentenceStart in seam.ts. */
fun lastSentenceStart(text: String): Int {
    val t = text.trimEnd()
    var start = 0
    for (m in Regex("""[.!?…]["')\]]*\s+""").findAll(t)) start = m.range.last + 1
    return start
}
