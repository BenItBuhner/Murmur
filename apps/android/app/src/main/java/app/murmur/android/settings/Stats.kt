package app.murmur.android.settings

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * Running totals of everything dictated on this phone: the numbers behind the home screen's
 * "words dictated", "speaking pace", "time saved" and "day streak". Same fields and the same
 * streak rule as the desktop app's `settings.stats` and the backend's `stats` table, so a signed-in
 * account can merge them. Device-local; when signed in the account's totals are shown instead.
 */
data class DictationStats(
    val totalWords: Int = 0,
    val totalSessions: Int = 0,
    val totalSpeechMs: Long = 0,
    val streakDays: Int = 0,
    /** Local calendar day (YYYY-MM-DD) of the last dictation; empty until the first one. */
    val lastSessionDay: String = ""
) {
    val isEmpty: Boolean get() = totalSessions == 0

    /** Count one finished dictation of [words] words and [speechMs] of speech, made on [day]. */
    fun record(words: Int, speechMs: Long, day: String): DictationStats = copy(
        totalWords = totalWords + words.coerceAtLeast(0),
        totalSessions = totalSessions + 1,
        totalSpeechMs = totalSpeechMs + speechMs.coerceAtLeast(0),
        streakDays = nextStreak(day),
        // A device in another time zone can report a day the streak has already moved past.
        lastSessionDay = if (lastSessionDay.isEmpty() || daysBetween(lastSessionDay, day) >= 0) day else lastSessionDay
    )

    /** Consecutive local days with at least one dictation, extended (or restarted) by a session on [day]. */
    fun nextStreak(day: String): Int {
        if (lastSessionDay.isEmpty()) return 1
        val gap = daysBetween(lastSessionDay, day)
        return when {
            gap == 0 -> maxOf(1, streakDays)
            gap == 1 -> streakDays + 1
            gap < 0 -> maxOf(1, streakDays)
            else -> 1
        }
    }

    companion object {
        val EMPTY = DictationStats()

        /** Whole days from [a] to [b], both YYYY-MM-DD; negative when [b] is earlier. */
        fun daysBetween(a: String, b: String): Int =
            ChronoUnit.DAYS.between(LocalDate.parse(a), LocalDate.parse(b)).toInt()

        /** The calendar day of [epochMs] where the user is, as YYYY-MM-DD. */
        fun localDay(epochMs: Long, zone: ZoneId = ZoneId.systemDefault()): String =
            Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate().toString()
    }
}
