package app.murmur.android.text

import app.murmur.android.settings.NumbersMode
import java.text.NumberFormat
import java.util.Locale

/**
 * Kotlin port of apps/desktop/src/core/text/numbers.ts: spelled-out numbers -> digits.
 *   "five pm" -> "5 pm"   "five thirty pm" -> "5:30 pm"   "twenty three percent" -> "23%"
 *   "ten dollars" -> "$10"   "two point five" -> "2.5"   "version two point three" -> "version 2.3"
 *   "twenty twenty six" -> "2026"   "three thousand" -> "3,000"   "the twenty first" -> "the 21st"
 */

private val ONES = mapOf(
    "zero" to 0, "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6, "seven" to 7,
    "eight" to 8, "nine" to 9, "ten" to 10, "eleven" to 11, "twelve" to 12, "thirteen" to 13,
    "fourteen" to 14, "fifteen" to 15, "sixteen" to 16, "seventeen" to 17, "eighteen" to 18, "nineteen" to 19
)
private val TENS = mapOf(
    "twenty" to 20, "thirty" to 30, "forty" to 40, "fourty" to 40, "fifty" to 50, "sixty" to 60,
    "seventy" to 70, "eighty" to 80, "ninety" to 90
)
private val SCALES = mapOf(
    "hundred" to 100L, "thousand" to 1_000L, "million" to 1_000_000L, "billion" to 1_000_000_000L,
    "trillion" to 1_000_000_000_000L
)
private val ORDINAL_ONES = mapOf(
    "first" to 1, "second" to 2, "third" to 3, "fourth" to 4, "fifth" to 5, "sixth" to 6, "seventh" to 7,
    "eighth" to 8, "ninth" to 9, "tenth" to 10, "eleventh" to 11, "twelfth" to 12, "thirteenth" to 13,
    "fourteenth" to 14, "fifteenth" to 15, "sixteenth" to 16, "seventeenth" to 17, "eighteenth" to 18,
    "nineteenth" to 19
)
private val ORDINAL_TENS = mapOf(
    "twentieth" to 20, "thirtieth" to 30, "fortieth" to 40, "fiftieth" to 50, "sixtieth" to 60,
    "seventieth" to 70, "eightieth" to 80, "ninetieth" to 90
)

/** Words that are number words; the repetition stage leaves runs of these alone. */
val NUMBER_WORDS: Set<String> = ONES.keys + TENS.keys + SCALES.keys + "oh"

private val MONTHS = Regex(
    "\\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?\\s*$",
    RegexOption.IGNORE_CASE
)
private val UNIT_AFTER = Regex(
    "^\\s*(?:percent|per\\s+cent|%|dollars?|bucks|cents?|euros?|pounds?|quid|yen|rupees?|francs?|pesos?|a\\.?m\\.?|p\\.?m\\.?|o'?clock|degrees?|km|kilomet(?:er|re)s?|miles?|met(?:er|re)s?|feet|foot|inch(?:es)?|cm|mm|centimet(?:er|re)s?|millimet(?:er|re)s?|kg|kilos?|kilograms?|grams?|lbs?|ounces?|oz|lit(?:er|re)s?|gallons?|ml|hours?|hrs?|minutes?|mins?|seconds?|secs?|ms|milliseconds?|weeks?|months?|years?|days?|gb|mb|kb|tb|gigabytes?|megabytes?|kilobytes?|terabytes?|px|pixels?|x|times|fps|hz|mph|kph|mbps|gbps)(?![\\p{L}\\p{N}])",
    RegexOption.IGNORE_CASE
)
private val NOUN_BEFORE = Regex(
    "\\b(?:number|num|chapter|page|pages|step|steps|room|figure|fig|table|line|lines|item|items|option|question|section|part|level|version|v|ver|release|build|episode|season|week|day|grade|floor|gate|platform|track|route|highway|exit|unit|apartment|apt|suite|zone|phase|tier|round|lap|size|sizes|group|team|iteration|sprint|ticket|issue|pr|bug|port|error|code|id|channel|volume|vol|article|paragraph|verse|psalm|scene|column|row|slide|invoice|flight|bus|train|task|point|score|scored|rating|rated|age|aged|ages|turned)\\.?\\s+$",
    RegexOption.IGNORE_CASE
)
private val TIME_BEFORE = Regex("\\b(?:at|around|about|by|until|till|before|after|from|to|between|since|past|@)\\s+$", RegexOption.IGNORE_CASE)
private val YEAR_BEFORE = Regex(
    "\\b(?:in|since|from|until|till|by|before|after|of|year|the|circa|around|about|to|through|born|founded|established|back|early|late|mid|summer|winter|spring|fall|autumn|class|copyright)\\s+$",
    RegexOption.IGNORE_CASE
)
private val AMPM = Regex("^\\s*(a\\.?m\\.?|p\\.?m\\.?)(?![\\p{L}\\p{N}])", RegexOption.IGNORE_CASE)
private val OCLOCK = Regex("^\\s*o'?clock(?![\\p{L}])", RegexOption.IGNORE_CASE)
private val VERSION_BEFORE = Regex(
    "\\b(?:version|v|ver|release|python|node|java|php|ruby|ios|android|macos|windows|ubuntu|angular|vue|kotlin|typescript)\\.?\\s+$",
    RegexOption.IGNORE_CASE
)
private val ONE_IDIOM_AFTER = Regex(
    "^\\s+(?:of|another|day|time|thing|more|way|hand|else|side|last|final|moment|minute|second|by|on|to|at|in|for|with|or|and|please|too|that|who|which|point|step|bit|little|other)(?![\\p{L}\\p{N}])",
    RegexOption.IGNORE_CASE
)
private val ONE_IDIOM_BEFORE = Regex(
    "\\b(?:no|some|any|every|each|which|this|that|the|only|just|number|anyone|someone|everyone|nobody|somebody|everybody|day|one)\\s+$",
    RegexOption.IGNORE_CASE
)
private val PERCENT_AFTER = Regex("^\\s*(?:percent|per\\s+cent)(?![\\p{L}])", RegexOption.IGNORE_CASE)
private val MONEY_AFTER = Regex("^\\s*(dollars?|euros?)(?![\\p{L}])", RegexOption.IGNORE_CASE)
private val CENTS_AFTER = Regex("^\\s+and\\s+([\\p{L}\\p{N}]+(?:[\\s-][\\p{L}\\p{N}]+)?)\\s+cents?(?![\\p{L}])", RegexOption.IGNORE_CASE)

private data class NTok(val text: String, val lower: String, val start: Int, val end: Int)

private val NTOKEN_RE = Regex("[\\p{L}\\p{N}]+(?:['’][\\p{L}]+)?")

private fun ntokenize(text: String): List<NTok> =
    NTOKEN_RE.findAll(text).map { NTok(it.value, it.value.lowercase(), it.range.first, it.range.last + 1) }.toList()

private fun joined(text: String, a: NTok, b: NTok): Boolean = Regex("^[\\s-]+$").matches(text.substring(a.end, b.start))
private fun isDigits(s: String): Boolean = Regex("^\\d+$").matches(s)
private fun isSmallOnes(t: NTok?): Boolean = t != null && (ONES[t.lower] ?: 100) <= 9

data class ParsedNumber(
    val value: Long,
    val next: Int,
    val scaled: Boolean,
    val keepScale: String? = null,
    val fraction: String? = null,
    val digitRun: Boolean = false,
    /**
     * The digits of a digit run exactly as spoken. "zero zero zero seven" is a code, not the
     * number seven: leading zeros are part of what was said and `value` cannot hold them.
     */
    val literal: String? = null,
    val yearLike: Boolean = false,
    val blocked: Boolean = false,
    /** The second half of a blocked pair ("fifty" in "seventeen fifty"). */
    val tail: Long? = null
)

/**
 * Digits spoken one by one: three or more single digits in a row ("zero zero seven", "five five
 * five one two one two"). An "oh" between digits is a zero ("four oh seven"); one at the very end
 * is an interjection and stays outside the run.
 */
private fun parseDigitRun(tokens: List<NTok>, i: Int, contiguous: (Int) -> Boolean): Pair<String, Int>? {
    if (!isSmallOnes(tokens[i])) return null
    var k = i
    val digits = StringBuilder()
    var next = i
    while (k < tokens.size && contiguous(k)) {
        val w = tokens[k].lower
        if (isSmallOnes(tokens[k])) {
            digits.append(ONES.getValue(w))
            k++
            next = k
            continue
        }
        if ((w == "oh" || w == "o") && digits.isNotEmpty()) {
            digits.append('0')
            k++
            continue
        }
        break
    }
    // Trailing "oh"s were never counted: `digits` is cut back to the last real digit.
    if (next < k) digits.setLength(digits.length - (k - next))
    if (digits.length < 3) return null
    return digits.toString() to next
}

private fun parseCardinal(tokens: List<NTok>, text: String, i: Int): ParsedNumber? {
    fun at(k: Int): NTok? = tokens.getOrNull(k)
    fun contiguous(k: Int): Boolean = k == i || (k in 1 until tokens.size && joined(text, tokens[k - 1], tokens[k]))
    val before = text.substring(0, tokens[i].start)

    parseDigitRun(tokens, i) { k -> contiguous(k) }?.let { (literal, next) ->
        return ParsedNumber(literal.toLong(), next, false, digitRun = true, literal = literal)
    }

    var j = i
    var total = 0L
    var current = 0L
    var sawAny = false
    var scaled = false
    var keepScale: String? = null
    var lastScale = Long.MAX_VALUE
    var hasTens = false
    var hasOnes = false
    // The ones/tens group that follows the last scale word, so "five thousand five thousand" can
    // give the second "five" back instead of reading it as 5,005 with a stray "thousand".
    var groupStart = i
    var group = 0L

    fun skipAnd() {
        val a = at(j)
        val n = at(j + 1)
        if (a?.lower == "and" && contiguous(j) && n != null && contiguous(j + 1) && (n.lower in ONES || n.lower in TENS)) j++
    }
    fun rollBackGroup() {
        if (group > 0 && scaled) {
            current -= group
            j = groupStart
        }
    }

    if (at(j)?.lower == "a" && at(j + 1) != null && contiguous(j + 1) && at(j + 1)!!.lower in SCALES) {
        current = 1
        sawAny = true
        j++
    }
    while (j < tokens.size && contiguous(j)) {
        val w = at(j)!!.lower
        if (w in ONES || (isDigits(w) && w.length <= 3 && !sawAny)) {
            val v = ONES[w]?.toLong() ?: w.toLong()
            if (hasOnes) break
            if (hasTens && v >= 10) break
            current += v
            group += v
            hasOnes = true
            sawAny = true
            j++
            continue
        }
        if (w in TENS) {
            if (hasTens || hasOnes) break
            current += TENS.getValue(w)
            group += TENS.getValue(w)
            hasTens = true
            sawAny = true
            j++
            continue
        }
        if (w == "hundred") {
            if (!sawAny || current == 0L) break
            if (current >= 100) {
                // "one hundred one hundred": two numbers, not "101 hundred".
                rollBackGroup()
                break
            }
            current *= 100
            scaled = true
            hasTens = false
            hasOnes = false
            j++
            skipAnd()
            groupStart = j
            group = 0
            continue
        }
        if (w in SCALES) {
            val s = SCALES.getValue(w)
            if (!sawAny) break
            if (s >= lastScale) {
                // "five thousand five thousand": the second number starts at its own "five".
                rollBackGroup()
                break
            }
            if (s >= 1_000_000L) {
                keepScale = w
                j++
                break
            }
            total += (if (current == 0L) 1L else current) * s
            current = 0
            lastScale = s
            scaled = true
            hasTens = false
            hasOnes = false
            j++
            skipAnd()
            groupStart = j
            group = 0
            continue
        }
        break
    }
    if (!sawAny) return null

    var value = total + current
    var yearLike = false
    val nextTok = at(j)
    val pairFollows = !scaled && total == 0L && keepScale == null && nextTok != null && contiguous(j) &&
        (nextTok.lower in TENS || (ONES[nextTok.lower] ?: 0) >= 10 || nextTok.lower == "oh" || nextTok.lower == "hundred")
    if (pairFollows && value in 10..21) {
        val yr = parseYearTail(tokens, text, j)
        if (yr != null && (value == 19L || value == 20L || YEAR_BEFORE.containsMatchIn(before))) {
            value = value * 100 + yr.first
            j = yr.second
            yearLike = true
        } else if (yr != null) {
            return ParsedNumber(value, yr.second, false, blocked = true, tail = yr.first)
        }
    } else if (pairFollows && nextTok!!.lower != "hundred" && nextTok.lower != "oh") {
        val tail = (TENS[nextTok.lower] ?: ONES[nextTok.lower] ?: 0).toLong()
        return ParsedNumber(value, j + 1, false, blocked = true, tail = tail)
    }

    var fraction: String? = null
    if (at(j)?.lower == "point" && contiguous(j) && at(j + 1) != null && contiguous(j + 1)) {
        val frac = parseFraction(tokens, text, j + 1)
        if (frac != null) {
            fraction = frac.first
            j = frac.second
        }
    } else if (at(j)?.lower == "and" && contiguous(j) && at(j + 1)?.lower == "a" && at(j + 2) != null) {
        when (at(j + 2)!!.lower) {
            "half" -> { fraction = "5"; j += 3 }
            "quarter" -> { fraction = "25"; j += 3 }
        }
    }
    if (keepScale == null && fraction != null && at(j) != null && contiguous(j) && (SCALES[at(j)!!.lower] ?: 0L) >= 1_000_000L) {
        keepScale = at(j)!!.lower
        j++
    }
    return ParsedNumber(value, j, scaled, keepScale, fraction, yearLike = yearLike)
}

private fun parseYearTail(tokens: List<NTok>, text: String, j: Int): Pair<Long, Int>? {
    val t = tokens.getOrNull(j) ?: return null
    val w = t.lower
    val n = tokens.getOrNull(j + 1)
    val nJoined = n != null && joined(text, t, n)
    if (w == "hundred") return 0L to j + 1
    if (w == "oh" || w == "o") return if (nJoined && isSmallOnes(n)) ONES.getValue(n!!.lower).toLong() to j + 2 else null
    if (w in TENS) {
        if (nJoined && isSmallOnes(n)) return (TENS.getValue(w) + ONES.getValue(n!!.lower)).toLong() to j + 2
        return TENS.getValue(w).toLong() to j + 1
    }
    if ((ONES[w] ?: 0) >= 10) return ONES.getValue(w).toLong() to j + 1
    return null
}

private fun parseFraction(tokens: List<NTok>, text: String, j: Int): Pair<String, Int>? {
    val digits = StringBuilder()
    var k = j
    while (k < tokens.size && (k == j || joined(text, tokens[k - 1], tokens[k]))) {
        val t = tokens[k]
        val w = t.lower
        when {
            isSmallOnes(t) -> digits.append(ONES.getValue(w))
            w == "oh" || w == "o" -> digits.append('0')
            w in TENS -> {
                val n = tokens.getOrNull(k + 1)
                if (n != null && joined(text, t, n) && isSmallOnes(n)) {
                    digits.append(TENS.getValue(w) + ONES.getValue(n.lower))
                    k++
                } else digits.append(TENS.getValue(w))
            }
            isDigits(w) && digits.isEmpty() -> digits.append(w)
            else -> return if (digits.isEmpty()) null else digits.toString() to k
        }
        k++
    }
    return if (digits.isEmpty()) null else digits.toString() to k
}

private fun parseOrdinal(tokens: List<NTok>, text: String, i: Int): Pair<Int, Int>? {
    val t = tokens.getOrNull(i) ?: return null
    ORDINAL_ONES[t.lower]?.let { return it to i + 1 }
    ORDINAL_TENS[t.lower]?.let { return it to i + 1 }
    if (t.lower in TENS) {
        val n = tokens.getOrNull(i + 1)
        if (n != null && joined(text, t, n) && (ORDINAL_ONES[n.lower] ?: 100) <= 9) {
            return (TENS.getValue(t.lower) + ORDINAL_ONES.getValue(n.lower)) to i + 2
        }
    }
    return null
}

fun ordinalSuffix(n: Int): String {
    val mod100 = n % 100
    if (mod100 in 11..13) return "th"
    return when (n % 10) {
        1 -> "st"
        2 -> "nd"
        3 -> "rd"
        else -> "th"
    }
}

private fun formatInteger(value: Long, grouped: Boolean): String =
    if (!grouped || value < 1000) value.toString() else NumberFormat.getIntegerInstance(Locale.US).format(value)

private fun isSentenceStart(text: String, start: Int): Boolean {
    val before = text.substring(0, start)
    if (before.isBlank() || Regex("[.!?\\n]\\s*$").containsMatchIn(before)) return true
    val line = before.substring(before.lastIndexOf('\n') + 1)
    return Regex("^\\s*(?:[-•*]|\\d+\\.)\\s*$").matches(line)
}

private data class Replacement(val start: Int, val end: Int, val text: String)

fun convertNumbers(text: String, mode: NumbersMode): String {
    if (mode == NumbersMode.OFF || text.isEmpty()) return text
    val tokens = ntokenize(text)
    val replacements = ArrayList<Replacement>()
    val all = mode == NumbersMode.ALL

    var i = 0
    while (i < tokens.size) {
        val t = tokens[i]
        val before = text.substring(0, t.start)

        val time = parseTime(tokens, text, i)
        if (time != null && time.text != null) {
            replacements.add(Replacement(t.start, time.end, time.text))
            i = time.next
            continue
        }
        // Nothing marks it as a time: "five thirty" stays as spoken, but digits read out one by one
        // ("four oh seven", "one oh one") are a number.
        if (time != null && parseCardinal(tokens, text, i)?.digitRun != true) {
            i = time.next
            continue
        }
        // Versions: "version two point three point one" -> "version 2.3.1". Two or more "point"s are
        // a version wherever they occur; "two point zero point zero" is never "2.0 point zero".
        val ver = parseVersion(tokens, text, i)
        if (ver != null && (VERSION_BEFORE.containsMatchIn(before) || ver.dots >= 2)) {
            replacements.add(Replacement(t.start, tokens[ver.next - 1].end, ver.text))
            i = ver.next
            continue
        }
        val ord = parseOrdinal(tokens, text, i)
        if (ord != null) {
            val afterText = text.substring(tokens[ord.second - 1].end)
            val theBefore = Regex("\\bthe\\s+$", RegexOption.IGNORE_CASE).containsMatchIn(before)
            val convert = !isSentenceStart(text, t.start) && (
                ord.first >= 10 || MONTHS.containsMatchIn(before) ||
                    (theBefore && Regex("^\\s+of\\b", RegexOption.IGNORE_CASE).containsMatchIn(afterText)) ||
                    (theBefore && Regex("^\\s*,?\\s*\\d").containsMatchIn(afterText)) ||
                    (all && theBefore)
                )
            if (convert) replacements.add(Replacement(t.start, tokens[ord.second - 1].end, "${ord.first}${ordinalSuffix(ord.first)}"))
            i = ord.second
            continue
        }

        val num = parseCardinal(tokens, text, i)
        if (num == null) { i++; continue }
        if (num.blocked) { i = num.next; continue }
        val endTok = tokens[num.next - 1]
        val afterText = text.substring(endTok.end)
        val first = t.lower
        val percent = PERCENT_AFTER.find(afterText)
        val money = MONEY_AFTER.find(afterText)
        val unit = UNIT_AFTER.containsMatchIn(afterText)
        val noun = NOUN_BEFORE.containsMatchIn(before)
        val hasFraction = num.fraction != null
        val value = num.value
        val quantityContext = percent != null || money != null || unit || noun

        if (first == "one" && !hasFraction && !num.digitRun && !num.scaled && value == 1L) {
            if (!quantityContext || ONE_IDIOM_AFTER.containsMatchIn(afterText) || ONE_IDIOM_BEFORE.containsMatchIn(before)) {
                i = num.next
                continue
            }
        }
        if (first == "a" && !all && !(percent != null || money != null || unit)) { i = num.next; continue }

        val wantsDigits = all || hasFraction || num.digitRun || num.yearLike || value >= 10 || quantityContext || num.keepScale != null
        if (!wantsDigits) { i = num.next; continue }
        if (!all && isSentenceStart(text, t.start) && !(quantityContext || hasFraction || num.digitRun || num.yearLike) && value < 100) {
            i = num.next
            continue
        }

        val yearish = num.scaled && value in 1900..2099 && !quantityContext && !hasFraction
        val grouped = num.scaled && !num.yearLike && !num.digitRun && !yearish
        val digits = (num.literal ?: formatInteger(value, grouped)) + (if (hasFraction) ".${num.fraction}" else "")
        var end = endTok.end
        val out: String
        if (percent != null) {
            out = "$digits%"
            end += percent.value.length
        } else if (money != null) {
            val symbol = if (money.groupValues[1].startsWith("e", ignoreCase = true)) "€" else "$"
            end += money.value.length
            var cents = ""
            if (num.keepScale == null && !hasFraction) {
                val m = CENTS_AFTER.find(text.substring(end))
                if (m != null) {
                    val centTokens = ntokenize(m.groupValues[1])
                    val parsed = if (centTokens.isNotEmpty()) parseCardinal(centTokens, m.groupValues[1], 0) else null
                    val centVal: Long? = when {
                        parsed != null && !parsed.blocked -> parsed.value
                        isDigits(m.groupValues[1]) -> m.groupValues[1].toLong()
                        else -> null
                    }
                    if (centVal != null && centVal < 100) {
                        cents = "." + centVal.toString().padStart(2, '0')
                        end += m.value.length
                    }
                }
            }
            out = "$symbol$digits$cents" + (if (num.keepScale != null) " ${num.keepScale}" else "")
        } else {
            out = if (num.keepScale != null) "$digits ${num.keepScale}" else digits
        }
        replacements.add(Replacement(t.start, end, out))
        i = num.next
    }

    if (replacements.isEmpty()) return text
    val result = StringBuilder()
    var cursor = 0
    for (r in replacements) {
        if (r.start < cursor) continue
        result.append(text, cursor, r.start).append(r.text)
        cursor = r.end
    }
    result.append(text, cursor, text.length)
    return fixRanges(result.toString())
}

private val SIMPLE_WORDS = ONES.filterValues { it > 0 }.keys.joinToString("|")
private val RANGE_LEFT = Regex("\\b($SIMPLE_WORDS)(\\s+(?:to|or|through|-|–)\\s+)(\\d)", RegexOption.IGNORE_CASE)
private val RANGE_RIGHT = Regex("(\\d)(\\s+(?:to|or|through|-|–)\\s+)($SIMPLE_WORDS)\\b", RegexOption.IGNORE_CASE)

private fun fixRanges(text: String): String {
    var out = RANGE_LEFT.replace(text) { m -> "${ONES.getValue(m.groupValues[1].lowercase())}${m.groupValues[2]}${m.groupValues[3]}" }
    out = RANGE_RIGHT.replace(out) { m -> "${m.groupValues[1]}${m.groupValues[2]}${ONES.getValue(m.groupValues[3].lowercase())}" }
    return out
}

private fun hourValue(tok: NTok): Int? {
    ONES[tok.lower]?.let { if (it in 1..12) return it }
    if (isDigits(tok.lower) && tok.lower.length <= 2) tok.lower.toInt().let { if (it in 1..12) return it }
    return null
}

private fun minuteValue(tokens: List<NTok>, text: String, j: Int): Pair<Int, Int>? {
    val t = tokens.getOrNull(j) ?: return null
    val n = tokens.getOrNull(j + 1)
    val nJoined = n != null && joined(text, t, n)
    if (t.lower == "oh" || t.lower == "o") return if (nJoined && isSmallOnes(n)) ONES.getValue(n!!.lower) to j + 2 else null
    if (t.lower in TENS && TENS.getValue(t.lower) <= 50) {
        if (nJoined && isSmallOnes(n)) return (TENS.getValue(t.lower) + ONES.getValue(n!!.lower)) to j + 2
        return TENS.getValue(t.lower) to j + 1
    }
    if ((ONES[t.lower] ?: 0) >= 10) return ONES.getValue(t.lower) to j + 1
    if (isDigits(t.lower) && t.lower.length == 2 && t.lower.toInt() < 60) return t.lower.toInt() to j + 1
    return null
}

private data class TimeResult(val text: String?, val end: Int, val next: Int)

private fun parseTime(tokens: List<NTok>, text: String, i: Int): TimeResult? {
    val t = tokens[i]
    val hour = hourValue(t) ?: return null
    val before = text.substring(0, t.start)
    var next = i + 1
    var minutes: Int? = null
    if (tokens.getOrNull(next) != null && joined(text, t, tokens[next])) {
        minuteValue(tokens, text, next)?.let { minutes = it.first; next = it.second }
    }
    val endTok = tokens[next - 1]
    val after = text.substring(endTok.end)
    val ampm = AMPM.find(after)
    val oclock = OCLOCK.find(after)
    if (ampm == null && oclock == null) {
        if (minutes == null) return null
        if (!TIME_BEFORE.containsMatchIn(before) || isDigits(t.lower)) return TimeResult(null, endTok.end, next)
        return TimeResult("$hour:${minutes.toString().padStart(2, '0')}", endTok.end, next)
    }
    if (isDigits(t.lower) && minutes == null) return null
    var out = if (minutes == null) hour.toString() else "$hour:${minutes.toString().padStart(2, '0')}"
    if (oclock != null) out += " o'clock" else if (ampm != null) out += " " + ampm.groupValues[1].lowercase().replace(".", "")
    val end = endTok.end + (oclock ?: ampm)!!.value.length
    while (next < tokens.size && tokens[next].end <= end) next++
    return TimeResult(out, end, next)
}

private data class VersionResult(val text: String, val next: Int, val dots: Int)

private fun parseVersion(tokens: List<NTok>, text: String, i: Int): VersionResult? {
    val parts = ArrayList<String>()
    var j = i
    while (j < tokens.size && (j == i || joined(text, tokens[j - 1], tokens[j]))) {
        val t = tokens[j]
        val w = t.lower
        if (parts.size % 2 == 0) {
            when {
                w in ONES -> parts.add(ONES.getValue(w).toString())
                w in TENS -> {
                    val n = tokens.getOrNull(j + 1)
                    if (n != null && joined(text, t, n) && isSmallOnes(n)) {
                        parts.add((TENS.getValue(w) + ONES.getValue(n.lower)).toString())
                        j++
                    } else parts.add(TENS.getValue(w).toString())
                }
                isDigits(w) -> parts.add(w)
                else -> break
            }
        } else if (w == "point" || w == "dot") parts.add(".") else break
        j++
    }
    if (parts.size % 2 == 0 && parts.isNotEmpty()) {
        parts.removeAt(parts.size - 1)
        j--
    }
    if (parts.isEmpty()) return null
    if (parts.size == 1 && !(tokens[i].lower in ONES || tokens[i].lower in TENS)) return null
    return VersionResult(parts.joinToString(""), j, (parts.size - 1) / 2)
}
