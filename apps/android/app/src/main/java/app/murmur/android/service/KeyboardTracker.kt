package app.murmur.android.service

import app.murmur.android.overlay.Box
import kotlin.math.abs

/**
 * The on-screen keyboard as one accessibility window list reports it.
 *
 * [bounds] is where the list has the keyboard in the frame it was computed: SurfaceFlinger's view of
 * its window, so mid-slide while the keyboard animates in or out, or while an app drags it. [frame]
 * is where the keyboard's own views are laid out (its window frame, from the window's root node),
 * which does not move during those animations: it is where the keyboard comes to rest. Null when
 * the root could not be read.
 */
data class ImeWindow(val id: Int, val bounds: Box, val frame: Box?)

/**
 * Where the keyboard's top edge is, for the pill, from successive window lists.
 *
 * Android reports keyboard windows to accessibility services late and in snapshots: a keyboard
 * that slides in is typically first reported part of the way up (or once it has stopped). The pill
 * is parked relative to the keyboard's resting edge, so while the keyboard is still arriving the
 * tracker reports that resting edge (the frame's top, adjusted by what this keyboard's reported
 * edge was the last time it rested) rather than the snapshot's; once it has come to rest it follows
 * what the list reports (an app dragging the keyboard, the keyboard changing height). A keyboard
 * whose reported bounds are narrower than its own frame is being carried by a system animation
 * (swiping to Recents scales the app and its keyboard) and counts as gone.
 */
class KeyboardTracker(private val density: Float) {
    /** A keyboard is on screen. */
    var visible = false
        private set

    /** The top edge the pill measures from; kept after the keyboard leaves (-1 before the first one). */
    var top = -1
        private set

    /** While the keyboard is sliding in: when the snapshots are trusted over the frame regardless. */
    var arrivalDeadline: Long? = null
        private set

    private var appearedAt = 0L
    private var arriving = false

    /** Reported edge minus frame top when each keyboard window last rested (its touchable area can start below its frame). */
    private val restOffsets = HashMap<Int, Float>()

    /** Feeds one window list (null: no keyboard in it). Returns true when [visible] or [top] changed. */
    fun update(ime: ImeWindow?, nowMs: Long): Boolean {
        val wasVisible = visible
        val oldTop = top
        if (ime == null || !usable(ime)) {
            visible = false
            arriving = false
            arrivalDeadline = null
            return wasVisible
        }
        val reported = ime.bounds.top
        val frame = ime.frame
        val resting = frame?.let { it.top + (restOffsets[ime.id] ?: 0f) }
        if (!wasVisible) {
            appearedAt = nowMs
            arriving = resting != null && reported > resting + REST_SLOP_DP * density
            arrivalDeadline = if (arriving) nowMs + ARRIVAL_MAX_MS else null
        }
        if (arriving) {
            val atRest = resting == null || reported <= resting + REST_SLOP_DP * density
            if (atRest || nowMs - appearedAt >= ARRIVAL_MAX_MS) {
                arriving = false
                arrivalDeadline = null
                // Still lower than its frame after the longest slide: that is where this keyboard rests.
                if (!atRest && frame != null) {
                    val offset = reported - frame.top
                    if (abs(offset) <= MAX_REST_OFFSET_DP * density) restOffsets[ime.id] = offset
                }
            }
        }
        visible = true
        top = (if (arriving && resting != null) resting else reported).toInt()
        return !wasVisible || top != oldTop
    }

    private fun usable(ime: ImeWindow): Boolean {
        // Some keyboards keep a zero-height window alive while hidden.
        if (ime.bounds.height <= MIN_HEIGHT_PX) return false
        val frame = ime.frame ?: return true
        return ime.bounds.width >= frame.width * MIN_WIDTH_FRACTION
    }

    private companion object {
        /** Reported edges within this of the resting edge are at rest (rounding, the last frame of a slide). */
        const val REST_SLOP_DP = 1.5f

        /** Longer than any keyboard's slide in: after it, a keyboard lower than its frame is being dragged, not arriving. */
        const val ARRIVAL_MAX_MS = 450L

        /** A keyboard's touchable area may start a little below its frame; anything further is a drag in progress. */
        const val MAX_REST_OFFSET_DP = 24f

        const val MIN_HEIGHT_PX = 80f
        const val MIN_WIDTH_FRACTION = 0.9f
    }
}
