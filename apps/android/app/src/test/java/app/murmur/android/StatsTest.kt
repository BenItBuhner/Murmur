package app.murmur.android

import app.murmur.android.cloud.StatsDto
import app.murmur.android.cloud.SyncOp
import app.murmur.android.cloud.SyncReducers
import app.murmur.android.history.HistoryEntry
import app.murmur.android.history.StageTimings
import app.murmur.android.settings.DictationStats
import app.murmur.android.ui.TYPING_WPM
import app.murmur.android.ui.averageWords
import app.murmur.android.ui.daySummary
import app.murmur.android.ui.formatDuration
import app.murmur.android.ui.formatDurationShort
import app.murmur.android.ui.formatRelative
import app.murmur.android.ui.insightLines
import app.murmur.android.ui.mostUsedApp
import app.murmur.android.ui.timeSavedMs
import app.murmur.android.ui.wordsPerMinute
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StatsTest {

    @Test
    fun `the first dictation starts a streak of one`() {
        val s = DictationStats.EMPTY.record(words = 12, speechMs = 6_000, day = "2026-09-07")
        assertEquals(DictationStats(12, 1, 6_000, 1, "2026-09-07"), s)
    }

    @Test
    fun `dictating again the same day keeps the streak, the next day extends it, a gap resets it`() {
        var s = DictationStats.EMPTY.record(10, 5_000, "2026-09-07")
        s = s.record(10, 5_000, "2026-09-07")
        assertEquals(1, s.streakDays)
        s = s.record(10, 5_000, "2026-09-08")
        assertEquals(2, s.streakDays)
        s = s.record(10, 5_000, "2026-09-09")
        assertEquals(3, s.streakDays)
        s = s.record(10, 5_000, "2026-09-12")
        assertEquals(1, s.streakDays)
        assertEquals(50, s.totalWords)
        assertEquals(5, s.totalSessions)
        assertEquals(25_000L, s.totalSpeechMs)
        assertEquals("2026-09-12", s.lastSessionDay)
    }

    @Test
    fun `a day reported from an earlier time zone neither breaks the streak nor moves the last day back`() {
        val s = DictationStats(30, 3, 9_000, 3, "2026-09-09").record(5, 2_000, "2026-09-08")
        assertEquals(3, s.streakDays)
        assertEquals("2026-09-09", s.lastSessionDay)
    }

    @Test
    fun `negative words or speech never subtract`() {
        val s = DictationStats.EMPTY.record(-4, -100, "2026-09-07")
        assertEquals(0, s.totalWords)
        assertEquals(0L, s.totalSpeechMs)
    }

    @Test
    fun `days between and the local day follow the calendar, not UTC`() {
        assertEquals(1, DictationStats.daysBetween("2026-02-28", "2026-03-01"))
        assertEquals(-2, DictationStats.daysBetween("2026-09-07", "2026-09-05"))
        val tokyo = ZoneId.of("Asia/Tokyo")
        val lateEvening = ZonedDateTime.of(2026, 9, 7, 23, 30, 0, 0, tokyo).toInstant().toEpochMilli()
        assertEquals("2026-09-07", DictationStats.localDay(lateEvening, tokyo))
        assertEquals("2026-09-07", DictationStats.localDay(lateEvening, ZoneId.of("UTC")))
        assertEquals("2026-09-08", DictationStats.localDay(lateEvening + 60 * 60_000, tokyo))
    }

    @Test
    fun `pace and time saved use the same arithmetic as the desktop home page`() {
        // 400 words in 2 minutes of speech: 200 wpm; typing them at 40 wpm takes 10 minutes.
        val s = DictationStats(totalWords = 400, totalSessions = 4, totalSpeechMs = 120_000, streakDays = 1, lastSessionDay = "2026-09-07")
        assertEquals(200, wordsPerMinute(s))
        assertEquals(8 * 60_000L, timeSavedMs(s))
        assertEquals(40, TYPING_WPM)
        assertEquals(0, wordsPerMinute(DictationStats.EMPTY))
        assertEquals(0L, timeSavedMs(DictationStats(totalWords = 1, totalSpeechMs = 60_000)))
    }

    @Test
    fun `durations read like the desktop's`() {
        assertEquals("45s", formatDuration(45_000))
        assertEquals("3m 20s", formatDuration(200_000))
        assertEquals("5m", formatDuration(300_000))
        assertEquals("1h 05m", formatDuration(65 * 60_000))
        assertEquals("45 s", formatDurationShort(45_000))
        assertEquals("3 min", formatDurationShort(200_000))
        assertEquals("1.5 h", formatDurationShort(90 * 60_000))
    }

    @Test
    fun `relative times step from just now to the date`() {
        val now = 1_800_000_000_000L
        assertEquals("just now", formatRelative(now - 20_000, now))
        assertEquals("5 min ago", formatRelative(now - 5 * 60_000, now))
        assertEquals("3h ago", formatRelative(now - 3 * 3_600_000, now))
        assertTrue(formatRelative(now - 3 * 86_400_000, now, ZoneId.of("UTC")).matches(Regex("[A-Z][a-z]{2} \\d{1,2} \\d{1,2}:\\d{2} [AP]M")))
    }

    @Test
    fun `signed in, the account's totals plus what is still in the outbox are shown`() {
        val local = DictationStats(10, 1, 4_000, 4, "2026-09-07")
        val server = StatsDto(totalWords = 1_000.0, totalSessions = 40.0, totalSpeechMs = 300_000.0, streakDays = 2.0, lastSessionDay = "2026-09-06")
        val ops = listOf(
            SyncOp.StatsRecord("op1", "s1", words = 12, speechMs = 5_000, day = "2026-09-07"),
            SyncOp.StatsRecord("op2", "s2", words = 8, speechMs = 3_000, day = "2026-09-07")
        )
        val derived = SyncReducers.deriveStats(local, server, ops)
        assertEquals(1_020, derived.totalWords)
        assertEquals(42, derived.totalSessions)
        assertEquals(308_000L, derived.totalSpeechMs)
        assertEquals(4, derived.streakDays)
        assertEquals("2026-09-07", derived.lastSessionDay)

        // Nothing pending: the server's word is final, including its streak.
        val settled = SyncReducers.deriveStats(local, server, emptyList())
        assertEquals(1_000, settled.totalWords)
        assertEquals(2, settled.streakDays)
        assertEquals("2026-09-06", settled.lastSessionDay)

        // No snapshot yet: the phone's own numbers stand.
        assertEquals(local, SyncReducers.deriveStats(local, null, ops))
    }

    private fun entry(id: String, at: Long, words: Int, app: String? = "Messages", error: String? = null) = HistoryEntry(
        id = id, createdAt = at, rawText = "", finalText = if (error == null) "text" else "", wordCount = words, speechMs = 1000,
        appName = app, provider = "p", model = "m", injected = error == null, llmUsed = false,
        timings = StageTimings(totalMs = 900), error = error
    )

    @Test
    fun `today's summary counts only successful dictations made today`() {
        val zone = ZoneId.of("UTC")
        val today = ZonedDateTime.of(2026, 9, 7, 10, 0, 0, 0, zone).toInstant().toEpochMilli()
        val yesterday = today - 86_400_000
        val entries = listOf(
            entry("a", today, 20),
            entry("b", today + 60_000, 15),
            entry("c", today + 120_000, 0, error = "Nothing heard"),
            entry("d", yesterday, 99)
        )
        assertEquals(2, daySummary(entries, "2026-09-07", zone).sessions)
        assertEquals(35, daySummary(entries, "2026-09-07", zone).words)
        assertEquals(1, daySummary(entries, "2026-09-06", zone).sessions)
    }

    @Test
    fun `insights name the busiest app and the average, and stay quiet without data`() {
        val entries = listOf(
            entry("a", 1, 20, "Messages"),
            entry("b", 2, 30, "Messages"),
            entry("c", 3, 10, "Gmail"),
            entry("d", 4, 0, "Gmail", error = "Nothing heard")
        )
        assertEquals("Messages" to 2, mostUsedApp(entries))
        assertEquals(20, averageWords(entries))
        val lines = insightLines(entries, daySummary(entries, "1970-01-01", ZoneId.of("UTC")))
        assertTrue(lines.any { it.contains("About 20 words per dictation") })
        assertTrue(lines.any { it.contains("Most often in Messages") })
        assertTrue(insightLines(emptyList(), daySummary(emptyList(), "2026-09-07")).isEmpty())
        assertNull(mostUsedApp(emptyList()))
    }
}
