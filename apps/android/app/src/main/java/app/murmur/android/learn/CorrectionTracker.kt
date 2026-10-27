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

    /**
     * The corrections in the field's text now that were not reported by an earlier check, or null
     * when the user is still typing a word inside the dictation (the caret right after a letter
     * there, moments after it moved): "Conve" on the way to "Convex" resembles "convex" too, so
     * a half-typed word is never judged.
     */
    fun check(
        current: String,
        dictionary: List<DictionaryEntry>,
        everyday: Set<String>? = null,
        caret: Int = -1,
        typing: Boolean = false
    ): List<WordCorrection>? {
        val span = editedSpan(before, current, start, end) ?: return emptyList()
        val found = findCorrections(span.original, span.edited, dictionary, everyday)
        if (typing && found.any { endsAtCaret(current, it.word, caret) }) return null
        return found.filter { offered.add("${it.word.lowercase()}|${it.heard.lowercase()}") }
    }

    /** The word is the one the caret sits at the end of: the user may not have finished typing it. */
    private fun endsAtCaret(current: String, word: String, caret: Int): Boolean =
        caret >= word.length && caret <= current.length && current.regionMatches(caret - word.length, word, 0, word.length)

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
    private val everyday: () -> Set<String>? = { null },
    private val onFound: (List<WordCorrection>) -> Unit,
    private val clock: () -> Long = SystemClock::uptimeMillis,
    private val log: (String) -> Unit = {}
) {
    private class Session(val inserted: String, val read: () -> Pair<String, Int>?, val startedAt: Long) {
        var watch: CorrectionWatch? = null
        var baselineTries = 0
    }

    private var session: Session? = null
    private var lastNudgeAt = Long.MIN_VALUE / 2
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
        lastNudgeAt = clock()
        handler.removeCallbacks(nudged)
        handler.postDelayed(nudged, NUDGE_DELAY_MS)
    }

    fun stop() {
        session = null
        handler.removeCallbacks(tick)
        handler.removeCallbacks(nudged)
        handler.removeCallbacks(baseline)
    }

    /**
     * Find the dictation in the field. A web page (Chrome) reports a pasted text to accessibility
     * a moment after the paste, so an empty or older read is retried for a couple of seconds.
     */
    private fun takeBaseline() {
        val s = session ?: return
        val read = runCatching { s.read() }.getOrNull()
        val watch = read?.let { (text, caret) -> CorrectionWatch.locate(text, s.inserted, caret) }
        if (watch == null) {
            if (++s.baselineTries < BASELINE_TRIES) {
                handler.postDelayed(baseline, BASELINE_DELAY_MS)
            } else {
                log(if (read == null) "correction watch: the field is gone" else "correction watch: the dictation isn't in the field")
                stop()
            }
            return
        }
        s.watch = watch
        log("correction watch: watching ${watch.end - watch.start} chars")
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
        val (text, caret) = runCatching { s.read() }.getOrNull() ?: return stop()
        val typing = clock() - lastNudgeAt < TYPING_MS
        val found = watch.check(text, dictionary(), everyday(), caret, typing)
        if (found == null) {
            // Still typing a word: look again once the caret has rested.
            handler.removeCallbacks(nudged)
            handler.postDelayed(nudged, TYPING_MS)
            return
        }
        if (found.isNotEmpty()) {
            log("correction watch: found ${found.size} correction(s)")
            onFound(found)
        }
        scheduleNext()
    }

    companion object {
        const val BASELINE_DELAY_MS = 250L
        /** Reads to find the dictation before giving up (about two seconds). */
        const val BASELINE_TRIES = 8
        const val NUDGE_DELAY_MS = 1_200L
        /** The caret moved this recently: the user may still be in the middle of a word. */
        const val TYPING_MS = 3_000L
        /** Checks, counted from the insertion; watching ends after the last. */
        val CHECKS_MS = longArrayOf(4_000, 10_000, 20_000, 40_000, 60_000).toList()
    }
}
