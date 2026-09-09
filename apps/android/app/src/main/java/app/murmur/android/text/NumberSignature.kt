package app.murmur.android.text

import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * Port of packages/text-engine/src/numbers.ts. The number invariant: do two texts contain the
 * same numbers, in the same order? `digitSignature` reads every number in a text (spoken or
 * written) and returns the digits of all of them concatenated. Pinned to the TypeScript engine by
 * GoldenEngineTest; change both or neither.
 */
object NumberSignature {
    private val ONES = mapOf(
        "zero" to 0, "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6,
        "seven" to 7, "eight" to 8, "nine" to 9, "ten" to 10, "eleven" to 11, "twelve" to 12,
        "thirteen" to 13, "fourteen" to 14, "fifteen" to 15, "sixteen" to 16, "seventeen" to 17,
        "eighteen" to 18, "nineteen" to 19
    )
    private val TENS = mapOf(
        "twenty" to 20, "thirty" to 30, "forty" to 40, "fourty" to 40, "fifty" to 50,
        "sixty" to 60, "seventy" to 70, "eighty" to 80, "ninety" to 90
    )
    private val SPOKEN_SCALES = mapOf(
        "thousand" to 1e3, "grand" to 1e3, "k" to 1e3, "million" to 1e6, "billion" to 1e9, "trillion" to 1e12
    )
    private val WRITTEN_SCALES = SPOKEN_SCALES + mapOf("m" to 1e6, "bn" to 1e9)
    private val STANDALONE_SCALES = setOf("hundred", "thousand", "million", "billion", "trillion")
    private val ORDINALS = setOf(
        "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
        "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth",
        "eighteenth", "nineteenth", "twentieth", "thirtieth", "fortieth", "fiftieth", "sixtieth",
        "seventieth", "eightieth", "ninetieth", "hundredth", "thousandth", "millionth"
    )
    private val MONTHS = setOf(
        "january", "february", "march", "april", "may", "june", "july", "august", "september",
        "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
        "sept", "oct", "nov", "dec"
    )

    val NUMBER_WORDS: Set<String> =
        ONES.keys + TENS.keys + STANDALONE_SCALES + setOf("point", "oh", "half", "quarter", "double", "triple") + ORDINALS

    fun isNumberWord(w: String): Boolean = w.lowercase() in NUMBER_WORDS

    private class Tok(val text: String, val spaced: Boolean) {
        val lower: String = text.lowercase()
    }

    private val TOKEN_RE = Regex("\\d+(?:[.,:]\\d+)*|\\p{L}+(?:['’]\\p{L}+)?|[^\\s\\p{L}\\p{N}]")
    private val LIST_MARKER = Regex("^[ \\t]*(?:\\d{1,3}[.)]|[-*•–—])[ \\t]+", RegexOption.MULTILINE)
    private val ORDINAL_SUFFIX = Regex("^(?:st|nd|rd|th)$", RegexOption.IGNORE_CASE)
    private val PLAIN_NUMBER = Regex("^\\d+(?:\\.\\d+)?$")
    private val GROUPED_NUMBER = Regex("^\\d{1,3}(?:,\\d{3})+$")

    private fun tokenize(text: String, stripMarkers: Boolean): List<Tok> {
        val src = if (stripMarkers) LIST_MARKER.replace(text, "") else text
        val out = ArrayList<Tok>()
        var last = 0
        for (m in TOKEN_RE.findAll(src)) {
            val between = src.substring(last, m.range.first)
            out.add(Tok(m.value, m.range.first == 0 || between.any { it.isWhitespace() }))
            last = m.range.last + 1
        }
        return out
    }

    private fun isOnes(t: Tok?) = t != null && t.lower in ONES
    private fun isTens(t: Tok?) = t != null && t.lower in TENS
    private fun isDigits(t: Tok?) = t != null && t.text.first().isDigit()
    private fun isOh(t: Tok?) = t != null && (t.lower == "oh" || t.lower == "o")
    private fun isSpokenScale(t: Tok?) = t != null && t.lower in SPOKEN_SCALES
    private fun isDigitLike(t: Tok?) = isOnes(t) || isTens(t) || isOh(t) || isDigits(t)

    private fun digitsOf(value: Double): String {
        if (value.isNaN() || value.isInfinite() || abs(value) >= 1e18) return ""
        return abs(value).roundToLong().toString()
    }

    private class Written(val digits: String, val next: Int)

    private fun readWritten(tokens: List<Tok>, i: Int): Written {
        val t = tokens[i]
        val next = tokens.getOrNull(i + 1)
        if (next != null && !next.spaced && ORDINAL_SUFFIX.matches(next.text) && t.text.all { it.isDigit() })
            return Written("", i + 2)
        val prev = tokens.getOrNull(i - 1)
        if (prev != null && prev.lower in MONTHS && t.text.length <= 2 && t.text.all { it.isDigit() } && t.text.toInt() <= 31)
            return Written("", i + 1)
        if (next != null && (PLAIN_NUMBER.matches(t.text) || GROUPED_NUMBER.matches(t.text))) {
            val scale = WRITTEN_SCALES[next.lower]
            val ok = scale != null && (next.lower.length > 2 || next.lower == "k" || !next.spaced)
            if (ok) {
                val plain = t.text.replace(",", "").toDouble()
                return Written(digitsOf(plain * scale!!), i + 2)
            }
        }
        return Written(t.text.filter { it.isDigit() }, i + 1)
    }

    private class Spoken(val numbers: List<String>, val next: Int)

    private fun readSpoken(tokens: List<Tok>, i: Int): Spoken {
        val numbers = ArrayList<String>()
        var total = 0.0
        var current = 0.0
        var fraction: String? = null
        var hasOnes = false
        var hasTens = false
        var sawAny = false
        var afterScale = false
        var lastScale = Double.POSITIVE_INFINITY

        fun reset() {
            total = 0.0; current = 0.0; fraction = null; hasOnes = false; hasTens = false
            sawAny = false; afterScale = false; lastScale = Double.POSITIVE_INFINITY
        }
        fun flush() {
            if (!sawAny) return
            val whole = digitsOf(total + current)
            numbers.add(if (fraction != null) whole + fraction else whole)
            reset()
        }

        var j = i
        while (j < tokens.size) {
            val t = tokens[j]
            val w = t.lower
            val n = tokens.getOrNull(j + 1)

            if (t.text == "-" || t.text == ",") {
                if (sawAny && (isDigitLike(n) || n?.lower == "hundred" || isSpokenScale(n))) {
                    j++
                    continue
                }
                break
            }
            if (j > i && !t.spaced) {
                val prevText = tokens.getOrNull(j - 1)?.text ?: ""
                if (prevText != "-" && prevText != ",") break
            }

            if (w == "a" && !sawAny && (n?.lower == "hundred" || isSpokenScale(n))) {
                j++
                continue
            }
            if ((w == "double" || w == "triple") && (isOh(n) || (isOnes(n) && ONES[n!!.lower]!! <= 9))) {
                flush()
                val d = if (isOh(n)) "0" else ONES[n!!.lower].toString()
                repeat(if (w == "double") 2 else 3) { numbers.add(d) }
                j += 2
                continue
            }
            if (w == "and" && sawAny) {
                if (afterScale && (isOnes(n) || isTens(n))) {
                    j++
                    continue
                }
                val q = tokens.getOrNull(j + 2)?.lower
                if (n?.lower == "a" && (q == "half" || q == "quarter") && fraction == null) {
                    fraction = if (q == "half") "5" else "25"
                    j += 3
                    continue
                }
                break
            }
            if (isOh(t)) {
                if (!sawAny) break
                if (fraction != null) {
                    fraction += "0"
                } else {
                    if (!isDigitLike(n)) break
                    flush()
                    numbers.add("0")
                }
                j++
                continue
            }
            if (isOnes(t) || isTens(t)) {
                val v = if (isOnes(t)) ONES[w]!! else TENS[w]!!
                if (fraction != null) {
                    if (isTens(t) && isOnes(n) && ONES[n!!.lower]!! <= 9) {
                        fraction += (v + ONES[n.lower]!!).toString()
                        j += 2
                    } else {
                        fraction += v.toString()
                        j++
                    }
                    continue
                }
                if (isOnes(t)) {
                    if (hasOnes || (hasTens && v >= 10)) flush()
                    current += v
                    hasOnes = true
                } else {
                    if (hasTens || hasOnes) flush()
                    current += v
                    hasTens = true
                }
                sawAny = true
                afterScale = false
                j++
                continue
            }
            if (isDigits(t)) {
                flush()
                val r = readWritten(tokens, j)
                if (r.digits.isNotEmpty()) numbers.add(r.digits)
                j = r.next
                continue
            }
            if (w == "hundred") {
                if (!sawAny) current = 1.0
                if (current >= 100 && (hasOnes || hasTens)) {
                    val tail = current % 100
                    numbers.add(digitsOf(total + current - tail))
                    total = 0.0
                    current = if (tail == 0.0) 1.0 else tail
                }
                current = (if (current == 0.0) 1.0 else current) * 100
                hasOnes = false
                hasTens = false
                sawAny = true
                afterScale = true
                j++
                continue
            }
            if (isSpokenScale(t)) {
                if (!sawAny && w !in STANDALONE_SCALES) break
                val s = SPOKEN_SCALES[w]!!
                if (!sawAny) current = 1.0
                if (s >= lastScale) {
                    if (total != 0.0) numbers.add(digitsOf(total))
                    total = 0.0
                }
                val head = if (fraction != null) current + "0.$fraction".toDouble() else if (current == 0.0) 1.0 else current
                fraction = null
                total += head * s
                current = 0.0
                lastScale = s
                hasOnes = false
                hasTens = false
                sawAny = true
                afterScale = true
                j++
                continue
            }
            if ((w == "point" || w == "dot") && sawAny && isDigitLike(n)) {
                if (fraction != null) {
                    flush()
                    j++
                    continue
                }
                fraction = ""
                j++
                continue
            }
            break
        }
        flush()
        return Spoken(numbers, j)
    }

    private fun leadsNumber(t: Tok, n: Tok?): Boolean {
        if (isOnes(t) || isTens(t)) return true
        if (isOh(t)) return false
        if (t.lower in STANDALONE_SCALES) return true
        if (t.lower == "a") return n != null && (n.lower == "hundred" || isSpokenScale(n))
        if (t.lower == "double" || t.lower == "triple") return isOh(n) || (isOnes(n) && ONES[n!!.lower]!! <= 9)
        return false
    }

    /** Every number in `text`, spoken or written, as digits in order of appearance. */
    fun numberList(text: String, stripMarkers: Boolean = true): List<String> {
        val tokens = tokenize(text, stripMarkers)
        val out = ArrayList<String>()
        var i = 0
        while (i < tokens.size) {
            val t = tokens[i]
            if (isDigits(t)) {
                val r = readWritten(tokens, i)
                if (r.digits.isNotEmpty()) out.add(r.digits)
                i = r.next
                continue
            }
            if (leadsNumber(t, tokens.getOrNull(i + 1))) {
                val r = readSpoken(tokens, i)
                if (r.next > i) {
                    out.addAll(r.numbers)
                    i = r.next
                    continue
                }
            }
            i++
        }
        return out
    }

    /** All digits of all numbers in the text, in order. */
    fun digitSignature(text: String, stripMarkers: Boolean = true): String =
        numberList(text, stripMarkers).joinToString("")

    /** Words plus numbers, where a spoken number of any length counts once. */
    fun countUnits(text: String): Int {
        val tokens = tokenize(text, true)
        var count = 0
        var i = 0
        while (i < tokens.size) {
            val t = tokens[i]
            if (isDigits(t)) {
                count++
                i = readWritten(tokens, i).next
                continue
            }
            if (t.text.first().isLetter()) {
                if (leadsNumber(t, tokens.getOrNull(i + 1))) {
                    val r = readSpoken(tokens, i)
                    if (r.next > i) {
                        count += maxOf(1, r.numbers.size)
                        i = r.next
                        continue
                    }
                }
                count++
            }
            i++
        }
        return count
    }
}
