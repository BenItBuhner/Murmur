package app.murmur.android.text

import app.murmur.android.settings.BulletMarker
import app.murmur.android.settings.ListStyle
import app.murmur.android.settings.ListsMode

/**
 * Kotlin port of apps/desktop/src/core/text/lists.ts: deterministic list detection from spoken
 * commands ("bullet point …", "number one …"), requests ("make this a numbered list: …") and, in
 * AUTO mode, enumerations ("first…, second…", "1. …", "here are three things: a, b and c").
 */

enum class ListKind { BULLETS, NUMBERS }

data class ListIntent(
    /** BULLETS / NUMBERS / null when nothing was asked; `any` maps to requestedAny. */
    val requested: ListKind?,
    val requestedAny: Boolean,
    val explicit: Boolean,
    val markers: Int
)

data class ListOptions(
    val mode: ListsMode,
    val style: ListStyle,
    val marker: BulletMarker,
    val capitalize: Boolean
)

data class ListResult(val text: String, val applied: Boolean, val kind: ListKind?, val items: Int, val intent: ListIntent)

private val ORD_WORDS = mapOf(
    "first" to 1, "firstly" to 1, "second" to 2, "secondly" to 2, "third" to 3, "thirdly" to 3, "fourth" to 4,
    "fourthly" to 4, "fifth" to 5, "fifthly" to 5, "sixth" to 6, "seventh" to 7, "eighth" to 8, "ninth" to 9,
    "tenth" to 10, "eleventh" to 11, "twelfth" to 12
)
private val CARD_WORDS = mapOf(
    "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6, "seven" to 7, "eight" to 8,
    "nine" to 9, "ten" to 10, "eleven" to 11, "twelve" to 12, "thirteen" to 13, "fourteen" to 14, "fifteen" to 15,
    "sixteen" to 16, "seventeen" to 17, "eighteen" to 18, "nineteen" to 19, "twenty" to 20
)
private val COUNT_WORDS = CARD_WORDS + mapOf("couple" to 2, "few" to 0, "several" to 0, "some" to 0)

private const val KIND_WORDS = "(?:bullet(?:ed)?(?:\\s+point)?|numbered|ordered|unordered|dash(?:ed)?|to-?do|checklist|check)"
private const val LIST_NOUN = "(?:list|bullet\\s+points?|bullets|points)"

private val LEAD_INSTRUCTION = Regex(
    "^(?:(?:okay|ok|so|alright|um|uh|and|now)[,.]?\\s+)*" +
        "(?:(?:can|could|would)\\s+you\\s+(?:please\\s+)?|please\\s+|let's\\s+|i\\s+(?:want|need)\\s+(?:you\\s+)?to\\s+|just\\s+)?" +
        "(?:make|create|put|format|write|turn|give\\s+me|do|type|convert)\\s+" +
        "(?:(?:this|that|these|those|it|them|the\\s+following)\\s+)?" +
        "(?:(?:as|into|in|to)\\s+)?(?:(?:a|an)\\s+)?$KIND_WORDS?\\s*$LIST_NOUN" +
        "(?:\\s+(?:of|for|with)\\s+(?:this|that|these|it|them|the\\s+following))?(?:\\s+please)?[:,.]?\\s*",
    RegexOption.IGNORE_CASE
)
private val LEAD_LABEL = Regex(
    "^(?:(?:okay|ok|so|alright|um|uh)[,.]?\\s+)*(?:(?:as|in)\\s+(?:(?:a|an)\\s+)?)?$KIND_WORDS?\\s*$LIST_NOUN(?:\\s+(?:format|form))?[:,.]\\s*",
    RegexOption.IGNORE_CASE
)
private val TAIL_INSTRUCTION = Regex(
    "[,.;]?\\s*(?:(?:and\\s+)?(?:make|put|format|write|turn)\\s+(?:this|that|these|it|them)\\s+)?(?:as|in|into)\\s+(?:(?:a|an)\\s+)?$KIND_WORDS?\\s*$LIST_NOUN(?:\\s+(?:format|form))?(?:\\s+please)?[.!]?\\s*$",
    RegexOption.IGNORE_CASE
)
private val ANY_REQUEST = Regex("\\b(?:as|in|into)\\s+(?:(?:a|an)\\s+)?$KIND_WORDS?\\s*$LIST_NOUN\\b", RegexOption.IGNORE_CASE)

private const val ITEM_NOUNS =
    "(?:list|steps|items|things|points|tasks|options|reasons|ideas|notes|questions|actions|priorities|takeaways|to-?dos|goals|changes|issues|features|requirements|rules|tips|topics|suggestions|updates|requests|bullets)"
private val ENUMERATION_LEAD = Regex(
    "\\b(?:(?:here\\s+(?:are|is)|these\\s+are|there\\s+are|we\\s+(?:have|need)|i\\s+(?:have|need|want|see))\\s+(?:the\\s+|a\\s+|my\\s+|some\\s+|our\\s+)?(?:(one|two|three|four|five|six|seven|eight|nine|ten|\\d+|couple\\s+of|few|several|some)\\s+)?(?:main\\s+|key\\s+|quick\\s+|small\\s+|big\\s+|other\\s+)?$ITEM_NOUNS|the\\s+following(?:\\s+$ITEM_NOUNS)?|(one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+(?:main\\s+|key\\s+|quick\\s+)?$ITEM_NOUNS)\\s*([:,;]|\\s+-\\s+)",
    RegexOption.IGNORE_CASE
)

private const val ORDINAL_EXCLUDE =
    "(?!\\s+(?:time|name|place|floor|half|quarter|class|aid|person|day|week|month|year|grade|round|edition|version|draft|attempt|impression|language|priority|choice|option|of\\s+(?!all)|things\\s+first|come|thing\\s+in\\s+the|and\\s+foremost)\\b)"

private enum class MKind { BULLET, NUMBER, ORDINAL, DIGIT, CARDINAL, CONT }
private data class Marker(val kind: MKind, val value: Int, val start: Int, val end: Int)

private const val MARKER_TAIL = "(?![\\p{L}\\p{N}'’-])(?:\\s*[,:.–—-]+)?\\s*"
private const val CLAUSE_LEAD = "(^|(?<=[.!?;:\\n])\\s*|,\\s*(?:and\\s+|then\\s+|also\\s+)?|\\s+(?:and|then)\\s+)"

private val COMMAND_MARKER_RE = Regex(
    "(^|(?<=[.!?;:,\\n])\\s*|\\s+(?:and\\s+|then\\s+)?)" +
        "(?:(?<bullet>(?:(?:new|next|another)\\s+)?bullet(?:\\s+point)?|next\\s+(?:item|point|one)|new\\s+(?:item|point))" +
        "|(?<numKind>number|item|step|point|part|no\\.?|#)\\s*(?<numVal>${CARD_WORDS.keys.joinToString("|")}|\\d{1,2})(?:st|nd|rd|th)?)" +
        MARKER_TAIL,
    RegexOption.IGNORE_CASE
)
private val SPEECH_MARKER_RE = Regex(
    CLAUSE_LEAD +
        "(?:(?<ord>${ORD_WORDS.keys.joinToString("|")})(?:\\s+of\\s+all)?(?:\\s+(?:thing|point|item|step|one|up))?$ORDINAL_EXCLUDE" +
        "|(?<digit>\\d{1,2})[.)]" +
        "|(?<card>${CARD_WORDS.keys.joinToString("|")})(?=\\s*[,:])" +
        "|(?<cont>(?:and\\s+)?(?:lastly|finally|last\\s+but\\s+not\\s+least|last(?:ly)?)))" +
        MARKER_TAIL,
    RegexOption.IGNORE_CASE
)

/** Java throws for a group name the pattern lacks, so each pattern gets its own classifier. */
private fun scanWith(re: Regex, text: String, out: MutableList<Marker>, classify: (MatchResult) -> Marker?) {
    var from = 0
    while (from <= text.length) {
        val m = re.find(text, from) ?: break
        val start = m.range.first
        val end = m.range.last + 1
        val marker = classify(m)
        // A marker with nothing after it is not a marker (a lone spoken bullet still is).
        if (marker != null && (end < text.length || marker.kind == MKind.BULLET)) out.add(marker)
        from = maxOf(end, start + 1)
    }
}

private fun numberOf(s: String): Int = CARD_WORDS[s.lowercase()] ?: s.toInt()

private fun classifyCommand(m: MatchResult): Marker? {
    val start = m.range.first
    val end = m.range.last + 1
    val g = m.groups
    g["bullet"]?.let { return Marker(MKind.BULLET, 0, start, end) }
    g["numVal"]?.let { return Marker(MKind.NUMBER, numberOf(it.value), start, end) }
    return null
}

private fun classifySpeech(m: MatchResult): Marker? {
    val start = m.range.first
    val end = m.range.last + 1
    val g = m.groups
    g["ord"]?.let { return Marker(MKind.ORDINAL, ORD_WORDS.getValue(it.value.lowercase()), start, end) }
    g["digit"]?.let { return Marker(MKind.DIGIT, it.value.toInt(), start, end) }
    g["card"]?.let { return Marker(MKind.CARDINAL, CARD_WORDS.getValue(it.value.lowercase()), start, end) }
    g["cont"]?.let { return Marker(MKind.CONT, 0, start, end) }
    return null
}

private fun scanMarkers(text: String): List<Marker> {
    val out = ArrayList<Marker>()
    scanWith(COMMAND_MARKER_RE, text, out, ::classifyCommand)
    scanWith(SPEECH_MARKER_RE, text, out, ::classifySpeech)
    out.sortBy { it.start }
    val merged = ArrayList<Marker>()
    for (m in out) {
        val prev = merged.lastOrNull()
        if (prev != null && m.start < prev.end) continue
        merged.add(m)
    }
    return merged
}

private fun requestedKind(phrase: String): ListKind? = when {
    Regex("numbered|ordered|number", RegexOption.IGNORE_CASE).containsMatchIn(phrase) && !phrase.contains("unordered", true) -> ListKind.NUMBERS
    Regex("bullet|dash|unordered|check", RegexOption.IGNORE_CASE).containsMatchIn(phrase) -> ListKind.BULLETS
    else -> null
}

fun detectListIntent(text: String): ListIntent {
    var requested: ListKind? = null
    var any = false
    var explicit = false
    val req = LEAD_INSTRUCTION.find(text) ?: LEAD_LABEL.find(text) ?: TAIL_INSTRUCTION.find(text) ?: ANY_REQUEST.find(text)
    if (req != null) {
        requested = requestedKind(req.value)
        any = requested == null
        explicit = true
    }
    val markers = scanMarkers(text).filter { it.kind != MKind.CONT }
    if (markers.any { it.kind == MKind.BULLET }) {
        explicit = true
        if (requested == null && !any) requested = ListKind.BULLETS
    }
    if (markers.any { it.kind == MKind.NUMBER }) {
        explicit = true
        if (requested == null && !any) requested = ListKind.NUMBERS
    }
    return ListIntent(requested, any, explicit, markers.size)
}

private data class Built(val lead: String, val items: List<String>, val tail: String, val kind: ListKind)

fun formatLists(text: String, opts: ListOptions): ListResult {
    val intent = detectListIntent(text)
    if (opts.mode == ListsMode.OFF || text.isBlank()) return ListResult(text, false, null, 0, intent)

    var body = text
    var requested: ListKind? = null
    var requestedAny = false
    var explicit = false
    val lead = LEAD_INSTRUCTION.find(body) ?: LEAD_LABEL.find(body)
    if (lead != null) {
        requested = requestedKind(lead.value)
        requestedAny = requested == null
        explicit = true
        body = body.substring(lead.value.length)
    }
    val tail = TAIL_INSTRUCTION.find(body)
    if (tail != null && tail.range.first > 0) {
        if (requested == null && !requestedAny) {
            requested = requestedKind(tail.value)
            requestedAny = requested == null
        }
        explicit = true
        body = body.substring(0, tail.range.first)
    }
    if (!explicit) {
        val any = ANY_REQUEST.find(body)
        if (any != null) {
            requested = requestedKind(any.value)
            requestedAny = requested == null
            explicit = true
        }
    }

    val markers = scanMarkers(body)
    val fromMarkers = buildFromMarkers(body, markers, opts, explicit)
    if (fromMarkers != null) return render(fromMarkers, opts, requested, intent.copy(explicit = explicit))
    val enumerated = buildFromEnumeration(body, opts, explicit, requested)
    if (enumerated != null) return render(enumerated, opts, requested, intent.copy(explicit = explicit))
    if (explicit && body != text) return ListResult(body.trim(), false, null, 0, intent.copy(explicit = true))
    return ListResult(text, false, null, 0, intent)
}

private fun buildFromMarkers(body: String, markers: List<Marker>, opts: ListOptions, explicit: Boolean): Built? {
    if (markers.isEmpty()) return null
    val spokenOnly = opts.mode == ListsMode.SPOKEN && !explicit
    val startIdx = markers.indexOfFirst { m ->
        when {
            m.kind == MKind.BULLET -> true
            m.kind == MKind.CONT -> false
            spokenOnly && m.kind != MKind.NUMBER -> false
            else -> m.value == 1
        }
    }
    if (startIdx < 0) return null

    val boundaries = ArrayList<Marker>()
    boundaries.add(markers[startIdx])
    var expect = 2
    var numbered = markers[startIdx].kind != MKind.BULLET
    var sawBulletKind = markers[startIdx].kind == MKind.BULLET
    for (i in startIdx + 1 until markers.size) {
        val m = markers[i]
        if (m.kind == MKind.BULLET) {
            boundaries.add(m)
            sawBulletKind = true
            continue
        }
        if (spokenOnly && m.kind != MKind.NUMBER) continue
        if (m.kind == MKind.CONT) {
            if (boundaries.size >= 2) boundaries.add(m)
            continue
        }
        if (m.value == expect) {
            boundaries.add(m)
            expect++
            numbered = true
        }
    }

    val real = boundaries.filter { it.kind != MKind.CONT }
    val cardinalOnly = real.all { it.kind == MKind.CARDINAL }
    val ordinalOnly = real.all { it.kind == MKind.ORDINAL }
    val minItems = if (explicit) 1 else 2
    if (real.size < minItems) return null
    if (boundaries.size < 2 && !(explicit && sawBulletKind)) return null
    if (ordinalOnly && opts.mode != ListsMode.AUTO && !explicit) return null

    val leadRaw = body.substring(0, boundaries[0].start)
    if (cardinalOnly && !explicit && real.size < 3 && !Regex(":\\s*$").containsMatchIn(leadRaw.trim())) return null

    val items = ArrayList<String>()
    for (i in boundaries.indices) {
        val from = boundaries[i].end
        val to = if (i + 1 < boundaries.size) boundaries[i + 1].start else body.length
        items.add(body.substring(from, to))
    }

    var tail = ""
    val lastBreak = items.last().indexOf("\n\n")
    if (lastBreak >= 0) {
        tail = items.last().substring(lastBreak).trim()
        items[items.size - 1] = items.last().substring(0, lastBreak)
    } else if (items.size >= 3) {
        val prior = items.subList(0, items.size - 1)
        val last = items.last()
        val sentenceEnd = Regex("[.!?]\\s+(?=\\S)").find(last)
        if (sentenceEnd != null && prior.all { !Regex("[.!?]\\s+\\S").containsMatchIn(it.trim()) }) {
            tail = last.substring(sentenceEnd.range.last + 1).trim()
            items[items.size - 1] = last.substring(0, sentenceEnd.range.first + 1)
        }
    }
    val cleaned = evenOutPeriods(items.map(::cleanItem).filter { it.isNotEmpty() })
    if (cleaned.size < minItems) return null
    val kind = if (numbered && !sawBulletKind) ListKind.NUMBERS else ListKind.BULLETS
    return Built(cleanLead(leadRaw), cleaned, tail, kind)
}

private fun evenOutPeriods(items: List<String>): List<String> {
    if (items.size < 2) return items
    val ends = items.map { Regex("[.!?]$").containsMatchIn(it) }
    if (ends.dropLast(1).all { it } && !ends.last()) return items.dropLast(1) + "${items.last()}."
    return items
}

private fun buildFromEnumeration(body: String, opts: ListOptions, explicit: Boolean, requested: ListKind?): Built? {
    val m = ENUMERATION_LEAD.find(body)
    var leadEnd: Int
    var expectedCount = 0
    if (m != null) {
        leadEnd = m.range.last + 1
        val countWord = (m.groupValues[1].ifEmpty { m.groupValues[2] }).lowercase().replace(Regex("\\s+of$"), "")
        if (countWord.isNotEmpty()) expectedCount = countWord.toIntOrNull() ?: (COUNT_WORDS[countWord] ?: 0)
    } else if (explicit) {
        val colon = body.indexOf(':')
        leadEnd = if (colon >= 0 && colon < body.length / 2) colon + 1 else 0
    } else return null
    if (m != null && opts.mode != ListsMode.AUTO && !explicit) return null

    val lead = body.substring(0, leadEnd)
    var rest = body.substring(leadEnd).trim()
    var tail = ""
    val para = rest.indexOf("\n\n")
    if (para >= 0) {
        tail = rest.substring(para).trim()
        rest = rest.substring(0, para).trim()
    }
    if (rest.isEmpty()) return null

    var items = rest.split(Regex("\\n|;\\s*|,\\s*(?:and\\s+|or\\s+)?")).map { it.trim() }.filter { it.isNotEmpty() }
    if (items.size >= 2) {
        val last = items.last()
        val andSplit = Regex("^(.+?)\\s+(?:and|or)\\s+(.+)$", RegexOption.IGNORE_CASE).find(last)
        if (andSplit != null && wordCount(andSplit.groupValues[1]) <= 6 && wordCount(andSplit.groupValues[2]) <= 12 &&
            (expectedCount == 0 || items.size + 1 == expectedCount)
        ) items = items.dropLast(1) + andSplit.groupValues[1] + andSplit.groupValues[2]
    } else if (items.size == 1 && explicit) {
        val parts = items[0].split(Regex("\\s+(?:and|or)\\s+", RegexOption.IGNORE_CASE)).map { it.trim() }
        if (parts.size >= 2 && parts.all { wordCount(it) <= 8 }) items = parts
    }
    if (items.size < 2) return null
    if (expectedCount >= 2 && items.size != expectedCount) return null
    if (items.any { wordCount(it) > 14 }) return null
    if (!explicit && items.any { wordCount(it) > 10 }) return null

    val cleaned = items.map(::cleanItem).filter { it.isNotEmpty() }
    if (cleaned.size < 2) return null
    val kind = if (requested == ListKind.NUMBERS) ListKind.NUMBERS else ListKind.BULLETS
    return Built(cleanLead(lead), cleaned, tail, kind)
}

private fun wordCount(s: String): Int = Regex("[\\p{L}\\p{N}]+").findAll(s).count()

private fun cleanItem(raw: String): String {
    var s = raw.replace(Regex("\\s+"), " ").trim()
    s = s.replace(Regex("^[,.;:\\-–—\\s]+"), "")
    s = s.replace(Regex("^(?:and|then|also|or)\\s+", RegexOption.IGNORE_CASE), "")
    s = s.replace(Regex("[,;:\\s]+$"), "")
    s = s.replace(Regex("[,\\s]+(?:and|or|then)$", RegexOption.IGNORE_CASE), "")
    s = s.replace(Regex("[,;:\\s]+$"), "")
    return s
}

private fun cleanLead(raw: String): String {
    var s = raw.replace(Regex("[ \\t]+"), " ").trim()
    if (s.isEmpty()) return ""
    s = s.replace(Regex("[,;:\\s]+(?:and|then|so)$", RegexOption.IGNORE_CASE), "")
    s = s.replace(Regex("[,;\\s\\-–—]+$"), "")
    if (!Regex("[.!?:]$").containsMatchIn(s)) s += ":"
    return s
}

private fun render(built: Built, opts: ListOptions, requested: ListKind?, intent: ListIntent): ListResult {
    var kind = built.kind
    if (requested != null) kind = requested
    when (opts.style) {
        ListStyle.BULLETS -> kind = ListKind.BULLETS
        ListStyle.NUMBERS -> kind = ListKind.NUMBERS
        ListStyle.AUTO -> Unit
    }
    val lines = built.items.mapIndexed { i, item ->
        val t = if (opts.capitalize) capitalizeFirst(item) else item
        if (kind == ListKind.NUMBERS) "${i + 1}. $t" else "${opts.marker.symbol} $t"
    }
    val parts = ArrayList<String>()
    if (built.lead.isNotEmpty()) parts.add(if (opts.capitalize) capitalizeFirst(built.lead) else built.lead)
    parts.add(lines.joinToString("\n"))
    var text = parts.joinToString("\n")
    text += if (built.tail.isNotEmpty()) "\n\n" + (if (opts.capitalize) capitalizeFirst(built.tail) else built.tail) else "\n"
    return ListResult(text, true, kind, built.items.size, intent)
}

/** Settle on the configured marker and "1." so lists look the same however they were produced. */
fun normalizeListMarkers(text: String, marker: BulletMarker): String = text
    .replace(Regex("(^|\\n)[ \\t]*[-•*–—·▪◦]\\s+(?=\\S)")) { m -> "${m.groupValues[1]}${marker.symbol} " }
    .replace(Regex("(^|\\n)[ \\t]*(\\d{1,3})[.)]\\s+(?=\\S)")) { m -> "${m.groupValues[1]}${m.groupValues[2]}. " }
