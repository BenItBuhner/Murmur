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
 * the root could not be read. [packageName] is the keyboard app's, when the root says.
 */
data class ImeWindow(val id: Int, val bounds: Box, val frame: Box?, val packageName: String? = null) {
    /** What identifies this keyboard across its windows and across restarts: its app, or failing that the window. */
    val key: String get() = packageName ?: "window:$id"
}

/**
 * How far below its frame each keyboard's reported top edge sits when it rests (its touchable area can
 * start below its window), in px, remembered per keyboard so a keyboard's resting edge is known the
 * moment its window is first reported.
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
 * plus what this keyboard is known to sit below it, or a report of it at rest); and whether it is
 * [displaced], reported well below where it rests (on its way out, or pulled most of the way out by
 * an app's scroll). [top] is always the resting edge. A keyboard reported well above where it rests
 * is being carried by a system animation (swiping to Recents lifts and shrinks the app with its
 * keyboard) and counts as gone: nothing else puts a keyboard above its own resting edge.
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

    /** While a keyboard whose resting edge is not known yet arrives: when its reported edge is trusted regardless. */
    var arrivalDeadline: Long? = null
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
        // A docked keyboard's window is the keyboard, at the bottom; a full-screen one says nothing about where it rests.
        var docked = frame != null && key !in untrustedFrames && frame.top >= screenH * MIN_DOCKED_TOP_FRACTION
        // Some keyboards keep a zero-height window alive while hidden.
        val usable = ime != null && ime.bounds.height > MIN_HEIGHT_PX &&
            (frame == null || ime.bounds.top >= frame.top + (known ?: 0f) - MAX_LIFT_DP * density)
        if (ime == null || key == null || !usable) {
            visible = false
            ready = false
            displaced = false
            arriving = false
            arrivalDeadline = null
            return before != listOf(visible, ready, displaced, top)
        }
        val reported = ime.bounds.top
        val slop = REST_SLOP_DP * density
        if (!visible) {
            appearedAt = nowMs
            arriving = true
            arrivalDeadline = nowMs + ARRIVAL_MAX_MS
        }
        var rest: Float? = if (docked && known != null) frame!!.top + known else null
        if (arriving) {
            when {
                rest != null && reported <= rest + slop -> arriving = false
                // Level with its frame: a keyboard's touch area never starts above its window, so it rests here.
                docked && known == null && reported <= frame!!.top + slop -> {
                    rest = reported
                    offsets[key] = reported - frame.top
                    arriving = false
                }
                nowMs - appearedAt >= ARRIVAL_MAX_MS -> {
                    arriving = false
                    if (docked) {
                        val offset = reported - frame!!.top
                        if (abs(offset) <= MAX_REST_OFFSET_DP * density) {
                            offsets[key] = offset
                            rest = reported
                        } else {
                            untrustedFrames += key
                            docked = false
                            rest = null
                        }
                    }
                }
            }
            if (!arriving) arrivalDeadline = null
        } else if (rest != null && reported < rest - slop && reported >= frame!!.top - slop) {
            // Resting higher than remembered (the keyboard changed its layout): that is its edge now.
            offsets[key] = reported - frame.top
            rest = reported
        }
        visible = true
        if (arriving) {
            ready = rest != null
            displaced = false
            top = (rest ?: reported).toInt()
        } else {
            ready = true
            if (rest != null || docked) {
                val edge = rest ?: (frame!!.top + (offsets[key] ?: 0f))
                top = edge.toInt()
                displaced = if (displaced) reported > edge + slop else reported > edge + DISPLACED_DP * density
            } else {
                // No docked frame to compare with: what the list reports is all there is.
                top = reported.toInt()
                displaced = false
            }
        }
        return before != listOf(visible, ready, displaced, top)
    }

    private companion object {
        /** Reported edges within this of the resting edge are at rest (rounding, the last frame of a slide). */
        const val REST_SLOP_DP = 1.5f

        /**
         * Reported this far below its resting edge, the keyboard is on its way out. Apps that tie the
         * keyboard to a scroll dip it less than this and let it spring back (about 30 dp on a Galaxy
         * S26 Ultra); the pill sits those out where it is.
         */
        const val DISPLACED_DP = 48f

        /** Longer than any keyboard's slide in: after it, the report is where it rests. */
        const val ARRIVAL_MAX_MS = 450L

        /** A keyboard's touchable area may start a little below its frame; anything further is a drag in progress. */
        const val MAX_REST_OFFSET_DP = 24f

        const val MIN_HEIGHT_PX = 80f

        /** Lifted this far above its resting edge, the keyboard is riding a system animation. */
        const val MAX_LIFT_DP = 24f

        /** A frame starting higher than this (as a fraction of the screen) is a container, not a docked keyboard. */
        const val MIN_DOCKED_TOP_FRACTION = 0.25f
    }
}
