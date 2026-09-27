package app.murmur.android.service

import app.murmur.android.overlay.Box
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The on-screen keyboard as one accessibility window list reports it.
 *
 * [bounds] is where the list has the keyboard in the frame it was computed: SurfaceFlinger's view of
 * its window, so mid-slide while the keyboard animates in or out, or while an app drags it. [frame]
 * is where the keyboard's own views are laid out (its window frame, from the window's root node),
 * which does not move during those animations: it is where the keyboard comes to rest. Null when
 * the root could not be read. [packageName] is the keyboard app's: from the root, or failing that the
 * system's default keyboard.
 */
data class ImeWindow(val id: Int, val bounds: Box, val frame: Box?, val packageName: String? = null) {
    /** What identifies this keyboard across its windows and across restarts: its app, or failing that the window. */
    val key: String get() = packageName ?: "window:$id"
}

/**
 * Where each keyboard's reported top edge sits when it rests, in px, remembered so a keyboard's
 * resting edge is known the moment its window is first reported. A docked keyboard is remembered by
 * how far below its frame that is, under its [ImeWindow.key]; one its window does not place (no
 * frame, a full-screen one, or one it was found not to rest in) by how far down its window it rests,
 * under the key and the window's size (or, without a frame, the screen's height). Where every keyboard
 * rests on a screen of a given height is kept as well ([KeyboardTracker.restKey]): it places a keyboard
 * whose frame has not been read yet, and one that has not been reported yet at all.
 */
interface KeyboardOffsets {
    operator fun get(keyboard: String): Float?
    operator fun set(keyboard: String, offset: Float)
}

class MemoryKeyboardOffsets : KeyboardOffsets {
    private val offsets = HashMap<String, Float>()
    override fun get(keyboard: String): Float? = offsets[keyboard]
    override fun set(keyboard: String, offset: Float) {
        offsets[keyboard] = offset
    }
}

/**
 * Where the keyboard is, for the pill, from successive window lists.
 *
 * Android reports keyboard windows to accessibility services late and in snapshots: a keyboard that
 * slides in is typically first reported part of the way up (or once it has stopped), and one that
 * slides out is reported mid-way or not until it is gone. The pill is parked relative to the
 * keyboard's resting edge and must never be seen anywhere else, so the tracker tells it three things:
 * whether a keyboard is [visible]; whether it is [ready], i.e. where it rests is known (its frame's top
 * plus what this keyboard is known to sit below it, where it rested last time in a window that does
 * not place it, or a report of it at rest); and whether it is [displaced], reported well below where
 * it rests (on its way out, or pulled most of the way out by an app's scroll). [top] is always the
 * resting edge. A keyboard reported well above where it rests is being carried by a system animation
 * (swiping to Recents lifts and shrinks the app with its keyboard) and counts as gone: nothing else
 * puts a keyboard above its own resting edge.
 */
class KeyboardTracker(private val density: Float, private val offsets: KeyboardOffsets = MemoryKeyboardOffsets()) {
    /** A keyboard is on screen. */
    var visible = false
        private set

    /** Where the keyboard rests is known: [top] is final, even while it is still sliding in. */
    var ready = false
        private set

    /** Reported well below where it rests: leaving, or dragged most of the way out. */
    var displaced = false
        private set

    /** The resting top edge the pill measures from; kept after the keyboard leaves (-1 before the first one). */
    var top = -1
        private set

    /**
     * While a keyboard arrives whose resting edge is not known, or is only remembered from last time:
     * when its reported edge is taken as where it rests regardless.
     */
    var arrivalDeadline: Long? = null
        private set

    /** What the last window list was taken as, for the timing log. */
    var decision = ""
        private set

    private var appearedAt = 0L
    private var arriving = false

    /** Keyboards whose frame turned out not to be where they rest (a floating keyboard in a larger window). */
    private val untrustedFrames = HashSet<String>()

    /** Feeds one window list (null: no keyboard in it). Returns true when anything the pill reads changed. */
    fun update(ime: ImeWindow?, nowMs: Long, screenH: Float): Boolean {
        val before = listOf(visible, ready, displaced, top)
        val frame = ime?.frame
        val key = ime?.key
        val known = key?.let { offsets[it] }
        val place = key?.let { placeKey(it, frame, screenH) }
        // Remembered from a window that did not place the keyboard: it still does not.
        val placed = place?.let { offsets[it] }
        // A docked keyboard's window is the keyboard, at the bottom; a full-screen one says nothing about where it rests.
        var docked = frame != null && key !in untrustedFrames && placed == null && frame.top >= screenH * MIN_DOCKED_TOP_FRACTION
        // Some keyboards keep a zero-height window alive while hidden. A sliver of a keyboard-sized
        // window is a keyboard just starting to slide in: the first report of one comes the moment its
        // window appears, when only its top row has risen into view.
        val sized = ime != null && (ime.bounds.height > MIN_HEIGHT_PX || (frame != null && frame.height > MIN_HEIGHT_PX))
        val lifted = ime != null && docked && ime.bounds.top < frame!!.top + (known ?: 0f) - MAX_LIFT_DP * density
        if (ime == null || key == null || place == null || ime.bounds.height <= 0f || !sized || lifted) {
            visible = false
            ready = false
            displaced = false
            arriving = false
            arrivalDeadline = null
            decision = when {
                ime == null -> "no keyboard window"
                ime.bounds.height <= 0f -> "no keyboard: its window is empty"
                !sized -> "no keyboard: ${ime.bounds.height.toInt()}px tall, no frame to say it is sliding in"
                else -> "gone: lifted above where it rests (a system animation)"
            }
            return before != listOf(visible, ready, displaced, top)
        }
        val reported = ime.bounds.top
        val slop = REST_SLOP_DP * density
        // What the keyboard's resting edge is measured from: its frame, or without one the screen's top.
        val anchor = frame?.top ?: 0f
        if (!visible) {
            appearedAt = nowMs
            arriving = true
            arrivalDeadline = nowMs + ARRIVAL_MAX_MS
        }
        // A docked keyboard is placed by its frame and offset; one whose offset is not known yet, by where it rested last time on a screen this tall.
        var rest: Float? = if (docked) known?.let { frame!!.top + it } ?: offsets[restKey(key, screenH)] else placed?.let { anchor + it }
        var why = ""
        val wasArriving = arriving
        var relearnt = false
        if (arriving) {
            when {
                rest != null && reported <= rest + slop -> {
                    arriving = false
                    why = "arrived at its known rest"
                    // Remembered from a window that does not place it, and now resting higher (a taller layout).
                    if (!docked && reported < rest - slop) {
                        offsets[place] = reported - anchor
                        rest = reported
                        why = "arrived above its remembered rest; learnt ${px(reported - anchor)} for $place"
                    }
                }
                // Not known yet, but reported within a hair of its frame: at rest. A keyboard is first
                // reported the moment its window appears, as it starts to slide in, far below its frame;
                // its next report comes once it has stopped moving (AccessibilityWindowsPopulator).
                docked && known == null && reported <= frame!!.top + MAX_REST_OFFSET_DP * density -> {
                    rest = reported
                    offsets[key] = reported - frame.top
                    arriving = false
                    why = "arrived within ${MAX_REST_OFFSET_DP.toInt()}dp of its frame; learnt ${px(reported - frame.top)} for $key"
                }
                nowMs - appearedAt >= ARRIVAL_MAX_MS -> {
                    arriving = false
                    val offset = reported - anchor
                    if (docked && offset >= -slop && offset <= frame!!.height * MAX_OFFSET_FRACTION) {
                        // Resting further below its frame than that (room it keeps above its keys, or
                        // lower than remembered): learnt now, and known from its first report next time.
                        offsets[key] = offset
                        rest = reported
                        why = "arrival deadline: learnt ${px(offset)} for $key"
                    } else {
                        // Its window does not place it: where it rests in that window is remembered
                        // instead, so the next time it is placed from its first report as well.
                        if (docked) untrustedFrames += key
                        val placedBy = if (docked) "rests ${px(offset)} down its frame, not placed by it; " else ""
                        docked = false
                        if (offset >= -slop) {
                            if (placed == null || abs(offset - placed) > slop) offsets[place] = offset
                            rest = reported
                            why = "arrival deadline: ${placedBy}learnt ${px(offset)} for $place"
                        } else {
                            rest = null
                            why = "arrival deadline: ${placedBy}reported above its window"
                        }
                    }
                }
                rest != null -> why = if (docked) "arriving; rest known from its frame" else "arriving; rest remembered for $place"
                else -> why = "arriving; rest not known yet"
            }
            if (!arriving) arrivalDeadline = null
        } else if (docked && rest != null && reported < rest - slop && reported >= frame!!.top - slop) {
            // Resting higher than remembered (the keyboard changed its layout): that is its edge now.
            offsets[key] = reported - frame.top
            rest = reported
            relearnt = true
            why = "resting higher than remembered; learnt ${px(reported - frame.top)} for $key"
        }
        // Where it came to rest is where this keyboard rests on a screen this tall: known from its
        // first report next time, before its frame has been read.
        if (rest != null && (relearnt || (wasArriving && !arriving))) rememberRest(key, screenH, rest)
        visible = true
        if (arriving) {
            ready = rest != null
            displaced = false
            top = (rest ?: reported).toInt()
        } else {
            ready = true
            if (docked) {
                val edge = rest ?: (frame!!.top + (offsets[key] ?: 0f))
                top = edge.toInt()
                displaced = if (displaced) reported > edge + slop else reported > edge + DISPLACED_DP * density
                if (why.isEmpty()) why = if (displaced) "displaced: reported ${reported.toInt()}" else "resting"
            } else {
                // No docked frame to compare with: what the list reports is all there is.
                top = (if (rest != null && abs(reported - rest) <= slop) rest else reported).toInt()
                displaced = false
                if (why.isEmpty()) why = "following its reports"
            }
        }
        decision = why
        return before != listOf(visible, ready, displaced, top)
    }

    private fun px(v: Float) = "${v.roundToInt()}px"

    private fun rememberRest(key: String, screenH: Float, rest: Float) {
        val restKey = restKey(key, screenH)
        val stored = offsets[restKey]
        if (stored == null || abs(stored - rest) > REST_SLOP_DP * density) offsets[restKey] = rest
    }

    companion object {
        /** Where a keyboard's resting top edge on a screen [screenH] tall is remembered, measured from the screen's top. */
        fun restKey(keyboard: String, screenH: Float): String = "$keyboard|h${screenH.roundToInt()}"

        /** Reported edges within this of the resting edge are at rest (rounding, the last frame of a slide). */
        private const val REST_SLOP_DP = 1.5f

        /**
         * Reported this far below its resting edge, the keyboard is on its way out. Apps that tie the
         * keyboard to a scroll dip it less than this and let it spring back (about 30 dp on a Galaxy
         * S26 Ultra); the pill sits those out where it is.
         */
        private const val DISPLACED_DP = 48f

        /**
         * Longer than any keyboard's slide in: after it, the report is where it rests. Waited for only
         * by a keyboard that cannot be placed sooner (one whose frame is unknown or not docked, the
         * first time it is seen, or one seen for the first time resting more than [MAX_REST_OFFSET_DP]
         * below its frame); one whose window does not place it but whose resting edge is remembered
         * is shown there at once, and moved if it has come to rest somewhere else by then.
         */
        private const val ARRIVAL_MAX_MS = 450L

        /**
         * A keyboard's touch area may start a little below its frame. Reported no further than this
         * below it, a keyboard seen for the first time is at rest: sliding in, it is far lower.
         */
        private const val MAX_REST_OFFSET_DP = 24f

        /** Past the longest slide, a keyboard may rest this far down its own window; any lower, the window is not the keyboard. */
        private const val MAX_OFFSET_FRACTION = 0.5f

        /** Shorter than this, a keyboard window whose frame is unknown, or no taller either, is not a keyboard on screen. */
        private const val MIN_HEIGHT_PX = 80f

        /** Lifted this far above its resting edge, the keyboard is riding a system animation. */
        private const val MAX_LIFT_DP = 24f

        /** A frame starting higher than this (as a fraction of the screen) is a container, not a docked keyboard. */
        private const val MIN_DOCKED_TOP_FRACTION = 0.25f

        /** Where a keyboard its window does not place is remembered: per window size, or without a frame per screen height. */
        private fun placeKey(key: String, frame: Box?, screenH: Float): String =
            if (frame != null) "$key|${frame.width.roundToInt()}x${frame.height.roundToInt()}" else restKey(key, screenH)
    }
}
