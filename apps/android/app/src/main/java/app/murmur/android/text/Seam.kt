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

    val hw = seamWords(h).takeLast(8)
    var tw = seamWords(t).take(8)
    var deduped = 0
    for (k in minOf(hw.size, tw.size) downTo 1) {
        var same = true
        for (i in 0 until k) if (hw[hw.size - k + i].key != tw[i].key) { same = false; break }
        if (same && (k >= 2 || tw[0].key.length >= 4 || tw[0].key in CONTINUATION)) { deduped = k; break }
    }
    val lastH = hw.lastOrNull()
    if (deduped == 0 && lastH != null && tw.isNotEmpty() && lastH.key in ARTICLES && tw[0].key in ARTICLES) {
        h = h.substring(0, lastH.start).trimEnd()
        val startsSentence = h.isEmpty() || Regex("""[.!?…]["')\]]*$""").containsMatchIn(h)
        if (!startsSentence) t = tw[0].text.lowercase() + t.substring(tw[0].end)
        if (h.isEmpty()) return SeamJoin(t, 1, false)
        deduped = 1
        tw = seamWords(t).take(8)
    } else if (deduped > 0) {
        t = t.substring(tw[deduped - 1].end).replace(Regex("""^[\s,;:.!?…-]+"""), "")
        if (t.isEmpty()) return SeamJoin(h, deduped, false)
        tw = seamWords(t).take(8)
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
    val bw = seamWords(before)
    val ow = seamWords(output)
    if (bw.size < 3 || ow.size <= 3) return output
    for (k in minOf(bw.size, ow.size - 1) downTo 3) {
        var same = true
        for (i in 0 until k) if (ow[i].key != bw[bw.size - k + i].key) { same = false; break }
        if (same) return output.substring(ow[k - 1].end).replace(Regex("""^[\s,;:.!?…-]+"""), "")
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
