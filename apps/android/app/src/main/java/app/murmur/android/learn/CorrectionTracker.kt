package app.murmur.android.learn

import android.os.Handler
import android.os.SystemClock
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.text.WordCorrection
import app.murmur.android.text.editedSpan
import app.murmur.android.text.findCorrections

/**
 * One dictation in one field, watched for the user correcting it. `before` is the field's text
 * right after Murmur typed into it, with the dictation at `[start, end)`.
 */
class CorrectionWatch(val before: String, val start: Int, val end: Int) {
    private val offered = HashSet<String>()

    /** The corrections in the field's text now that were not reported by an earlier check. */
    fun check(current: String, dictionary: List<DictionaryEntry>): List<WordCorrection> {
        val span = editedSpan(before, current, start, end) ?: return emptyList()
        return findCorrections(span.original, span.edited, dictionary)
            .filter { offered.add("${it.word.lowercase()}|${it.heard.lowercase()}") }
    }

    companion object {
        /**
         * Where `inserted` sits in the field: it ends at the caret (give or take the trailing space
         * Murmur adds), or failing that, its last occurrence. Null when it cannot be found.
         */
        fun locate(field: String, inserted: String, caret: Int): CorrectionWatch? {
            val text = inserted.trim()
            if (text.isEmpty()) return null
            var at = -1
            if (caret in 0..field.length) at = field.lastIndexOf(text, (caret - text.length).coerceAtLeast(0))
            if (at < 0 || at + text.length > caret + 1) at = field.lastIndexOf(text)
            if (at < 0) return null
            return CorrectionWatch(field, at, at + text.length)
        }
    }
}

/**
 * Re-reads the field after a dictation, the way Wispr Flow does, and reports a correction of a
 * mis-heard word so it can be offered for the dictionary. A field is read a few times over the
 * first minute and shortly after the caret moves (typing over a word moves it), so an edit is seen
 * even when the message is sent soon after. Everything runs on [handler]'s thread; a read is one
 * node refresh, cheap enough for the main thread.
 */
class CorrectionTracker(
    private val handler: Handler,
    private val dictionary: () -> List<DictionaryEntry>,
    private val onFound: (List<WordCorrection>) -> Unit,
    private val clock: () -> Long = SystemClock::uptimeMillis
) {
    private class Session(val inserted: String, val read: () -> Pair<String, Int>?, val startedAt: Long) {
        var watch: CorrectionWatch? = null
    }

    private var session: Session? = null
    private val tick = Runnable { check() }
    private val nudged = Runnable { check() }
    private val baseline = Runnable { takeBaseline() }

    /** Start watching a field Murmur just typed `inserted` into. `read` gives its text and caret, or null once it is gone. */
    fun start(inserted: String, read: () -> Pair<String, Int>?) {
        stop()
        if (inserted.isBlank()) return
        session = Session(inserted, read, clock())
        // The field reports its new text a moment after the insertion.
        handler.postDelayed(baseline, BASELINE_DELAY_MS)
    }

    /** The caret moved in the watched field: the user may be editing. */
    fun nudge() {
        val s = session ?: return
        if (s.watch == null) return
        handler.removeCallbacks(nudged)
        handler.postDelayed(nudged, NUDGE_DELAY_MS)
    }

    fun stop() {
        session = null
        handler.removeCallbacks(tick)
        handler.removeCallbacks(nudged)
        handler.removeCallbacks(baseline)
    }

    private fun takeBaseline() {
        val s = session ?: return
        val (text, caret) = runCatching { s.read() }.getOrNull() ?: return stop()
        s.watch = CorrectionWatch.locate(text, s.inserted, caret) ?: return stop()
        scheduleNext()
    }

    private fun scheduleNext() {
        val s = session ?: return
        val elapsed = clock() - s.startedAt
        val next = CHECKS_MS.firstOrNull { it > elapsed } ?: return stop()
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, next - elapsed)
    }

    private fun check() {
        val s = session ?: return
        val watch = s.watch ?: return
        val (text, _) = runCatching { s.read() }.getOrNull() ?: return stop()
        val found = watch.check(text, dictionary())
        if (found.isNotEmpty()) onFound(found)
        scheduleNext()
    }

    companion object {
        const val BASELINE_DELAY_MS = 250L
        const val NUDGE_DELAY_MS = 1_200L
        /** Checks, counted from the insertion; watching ends after the last. */
        val CHECKS_MS = longArrayOf(4_000, 10_000, 20_000, 40_000, 60_000).toList()
    }
}
