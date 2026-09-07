package app.murmur.android.ui

import app.murmur.android.history.HistoryEntry
import app.murmur.android.settings.DictationStats
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

/*
 * The numbers the home screen shows, worked out from the stats and the history. Pure functions,
 * the same arithmetic as the desktop app's Home page so both apps agree on what a day was worth.
 */

/** Words per minute a good typist manages; what dictation is measured against. */
const val TYPING_WPM = 40

/** Speaking pace over everything dictated, or 0 before the first dictation. */
fun wordsPerMinute(stats: DictationStats): Int {
    val minutes = stats.totalSpeechMs / 60_000.0
    return if (minutes > 0) (stats.totalWords / minutes).roundToInt() else 0
}

/** How much longer typing those words at [TYPING_WPM] would have taken than saying them. */
fun timeSavedMs(stats: DictationStats): Long =
    ((stats.totalWords.toDouble() / TYPING_WPM) * 60_000 - stats.totalSpeechMs).toLong().coerceAtLeast(0)

/** "45s", "3m 20s", "1h 05m": the desktop's `formatDuration`. */
fun formatDuration(ms: Long): String {
    val s = (ms / 1000.0).roundToInt()
    if (s < 60) return "${s}s"
    val m = s / 60
    val rem = s % 60
    if (m < 60) return if (rem > 0) "${m}m ${rem}s" else "${m}m"
    val h = m / 60
    return "${h}h ${(m % 60).toString().padStart(2, '0')}m"
}

/** Compact duration for a tile: "45 s", "3 min", "1.2 h". */
fun formatDurationShort(ms: Long): String {
    val s = ms / 1000.0
    return when {
        s < 60 -> "${s.roundToInt()} s"
        s < 3600 -> "${(s / 60).roundToInt()} min"
        else -> String.format(Locale.getDefault(), "%.1f h", s / 3600)
    }
}

fun formatCount(n: Int): String = NumberFormat.getIntegerInstance().format(n)

private val DateFmt = DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())
private val TimeFmt = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())

/** "just now", "5 min ago", "3h ago", then the date: the desktop's `formatRelative`. */
fun formatRelative(epochMs: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
    val min = (now - epochMs) / 60_000
    if (min < 1) return "just now"
    if (min < 60) return "$min min ago"
    val h = min / 60
    if (h < 24) return "${h}h ago"
    val at = Instant.ofEpochMilli(epochMs).atZone(zone)
    return "${DateFmt.format(at)} ${TimeFmt.format(at)}"
}

/** What one calendar day added up to. */
data class DaySummary(val sessions: Int, val words: Int)

/** Successful dictations made on [day] (YYYY-MM-DD, the user's zone). */
fun daySummary(entries: List<HistoryEntry>, day: String, zone: ZoneId = ZoneId.systemDefault()): DaySummary {
    var sessions = 0
    var words = 0
    for (e in entries) {
        if (e.failed || DictationStats.localDay(e.createdAt, zone) != day) continue
        sessions++
        words += e.wordCount
    }
    return DaySummary(sessions, words)
}

/** The app most dictated into, with how many times, or null when no entry named its app. */
fun mostUsedApp(entries: List<HistoryEntry>): Pair<String, Int>? =
    entries.asSequence()
        .filter { !it.failed && !it.appName.isNullOrBlank() }
        .groupingBy { it.appName!! }
        .eachCount()
        .maxByOrNull { it.value }
        ?.toPair()

/** Mean words per successful dictation, or 0. */
fun averageWords(entries: List<HistoryEntry>): Int {
    val ok = entries.filter { !it.failed && it.wordCount > 0 }
    return if (ok.isEmpty()) 0 else (ok.sumOf { it.wordCount }.toDouble() / ok.size).roundToInt()
}

/** The longest single dictation, by words. */
fun longestDictation(entries: List<HistoryEntry>): HistoryEntry? =
    entries.filter { !it.failed }.maxByOrNull { it.wordCount }

/** The most recent dictation that produced text, whose timings the home screen breaks down. */
fun lastSuccessful(entries: List<HistoryEntry>): HistoryEntry? = entries.firstOrNull { !it.failed && it.injected }

/** Short lines worth a glance under the stat tiles. Empty until there is something to say. */
fun insightLines(entries: List<HistoryEntry>, today: DaySummary): List<String> {
    val lines = ArrayList<String>(3)
    if (today.sessions > 0) {
        lines += "${pluralize(today.sessions, "dictation")} today, ${pluralize(today.words, "word")}."
    }
    averageWords(entries).takeIf { it > 0 }?.let { lines += "About $it words per dictation." }
    mostUsedApp(entries)?.let { (app, count) ->
        if (count >= 2) lines += "Most often in $app."
    }
    longestDictation(entries)?.takeIf { it.wordCount >= 40 }?.let {
        lines += "Longest so far: ${pluralize(it.wordCount, "word")} in one go."
    }
    return lines.take(3)
}
