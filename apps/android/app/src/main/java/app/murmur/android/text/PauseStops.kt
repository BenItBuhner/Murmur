package app.murmur.android.text

/**
 * Port of packages/text-engine/src/pause-stops.ts: sentence ends the speech model put at a pause
 * where no sentence can end. A sentence that ends on an article, possessive, preposition or
 * conjunction (Clean.SPLIT_WORDS), or on a modal followed by "Not" and a word that carries the
 * clause on ("I could. Not reproduce it"), is joined to the next. The next word is lower-cased only
 * when it is a frequent word (COMMON_WORDS) not capitalized mid-sentence elsewhere in the text.
 */
private val SPLIT = Clean.SPLIT_WORDS.toSet()

private val AUXILIARY = ("could would should can will did does do is are was were has have had might must may " +
    "need shall").split(" ").toSet()

private val NOT_FRAGMENT = ("today tonight now yet really sure quite much exactly at always anymore even in for that this " +
    "me you us them him her it a an the so too again ever necessarily everyone everything all " +
    "only just bad great good likely possible mine here there when if because with without to " +
    "after before until since one any like enough necessarily entirely completely").split(" ").toSet()

private val STOP = Regex("""(\p{L}+)(['’]\p{L}+)?\.(\s+)(\p{Lu}[\p{L}'’]*)(?=(\s+([\p{L}'’]+))?)""")

private fun isName(word: String, text: String): Boolean {
    if (Regex("""^I(['’](m|ll|ve|d))?$""").matches(word)) return true
    if (word.length > 1 && word == word.uppercase()) return true
    return Regex("""[\p{L}\p{N},;:]\s+""" + Regex.escape(word) + """(?![\p{L}'’])""").containsMatchIn(text)
}

fun joinPauseStops(text: String): String = STOP.replace(text) { m ->
    val last = m.groupValues[1]
    val clitic = m.groups[2]
    val next = m.groupValues[4]
    val after = m.groups[6]?.value
    // "plan A. Then": a capital letter is a name for an option, not an article.
    if (clitic != null || !last[0].isLowerCase()) return@replace m.value
    val key = last.lowercase()
    val split = key in SPLIT
    val not = key in AUXILIARY && next == "Not" && after != null && after.lowercase() !in NOT_FRAGMENT
    if (!split && !not) return@replace m.value
    val lower = next.lowercase()
    val kept = if (lower in COMMON_WORDS && !isName(next, text)) lower else next
    "$last $kept"
}
