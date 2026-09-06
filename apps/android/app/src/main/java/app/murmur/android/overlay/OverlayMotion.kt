package app.murmur.android.overlay

import kotlin.math.abs

/**
 * Timing for the floating pill: how the outline morphs between states and how the contents
 * cross-fade on top of it. Plain Kotlin (no android.*) so the model is unit-testable.
 *
 * The outline's size, colour and position ease over [MORPH_MS] (or [MOVE_MS] when only the
 * position changes). Contents are handled separately by a [LayerStack]: the incoming layer fades
 * in while every outgoing layer fades out, over [FADE_MS], with complementary curves so the two
 * alphas of a hand-over always sum to one. There is never a moment where the pill is a blank
 * blob, which is what the old "outgoing gone at 42 %, incoming starts at 32 %" schedule produced:
 * a dark, content-less pill on a dark keyboard that read as the button disappearing.
 */
object OverlayMotion {
    /** Outline morph between two states (size, corner radius, colour and position). */
    const val MORPH_MS = 340L

    /** Outline slide when only the anchor moves. */
    const val MOVE_MS = 240L

    /** Contents cross-fade. Shorter than the morph so the new contents are legible while the outline settles. */
    const val FADE_MS = 220L

    /** Alpha below which a layer is treated as gone. */
    const val GONE_ALPHA = 0.01f

    fun easeOutCubic(t: Float): Float {
        val u = 1f - t.coerceIn(0f, 1f)
        return 1f - u * u * u
    }

    /** Hermite ramp 0..1 over [a]..[b]; clamped outside. */
    fun smoothstep(a: Float, b: Float, x: Float): Float {
        if (b <= a) return if (x >= b) 1f else 0f
        val t = ((x - a) / (b - a)).coerceIn(0f, 1f)
        return t * t * (3f - 2f * t)
    }

    fun lerp(a: Float, b: Float, t: Float): Float = a + (b - a) * t

    fun lerp(a: Box, b: Box, t: Float): Box =
        Box(lerp(a.left, b.left, t), lerp(a.top, b.top, t), lerp(a.right, b.right, t), lerp(a.bottom, b.bottom, t))

    /** Progress 0..1 of a fade that began [elapsedMs] ago. */
    fun fadeProgress(elapsedMs: Long): Float = smoothstep(0f, 1f, elapsedMs.coerceAtLeast(0L).toFloat() / FADE_MS)

    /** Alpha of a layer fading in from [from] that started [elapsedMs] ago. */
    fun fadeIn(from: Float, elapsedMs: Long): Float = lerp(from, 1f, fadeProgress(elapsedMs))

    /** Alpha of a layer fading out from [from] that started [elapsedMs] ago. */
    fun fadeOut(from: Float, elapsedMs: Long): Float = from * (1f - fadeProgress(elapsedMs))

    /** Exponential approach with a time constant in milliseconds; frame-rate independent. */
    fun approach(current: Float, target: Float, dtMs: Long, tauMs: Float): Float {
        if (abs(target - current) < 0.0005f) return target
        return current + (target - current) * (1f - kotlin.math.exp(-dtMs / tauMs))
    }
}

/**
 * The pill's contents as a stack of layers, like the desktop overlay: the current layer fades in
 * on top of whatever is still fading out. Each layer keeps its own clock, so a state change that
 * lands mid-fade never discards anything visible. The layer that was current keeps the alpha it
 * had reached and fades out from there; older layers carry on fading on their own schedule; the
 * new layer starts from zero. Pushing contents that equal a layer still fading out promotes that
 * layer instead of starting over, so a quick A -> B -> A does not flicker.
 *
 * [T] is whatever describes a layer's contents; equality decides whether two layers are "the same".
 */
class LayerStack<T> {
    class Layer<T> internal constructor(
        var content: T,
        /** Where the contents are laid out (screen coordinates). Frozen once the layer is leaving. */
        var box: Box,
        /** Where the layer's box was when its current slide began; the box eases from here to its target. */
        var fromBox: Box,
        internal var since: Long,
        internal var alpha0: Float,
        var leaving: Boolean
    ) {
        /** When this layer became current (for content that animates itself in, e.g. the tick). */
        var shownSince: Long = since
            internal set
    }

    private val list = ArrayList<Layer<T>>(4)

    /** Oldest first; the current layer, if any, is last. */
    val layers: List<Layer<T>> get() = list

    val current: Layer<T>? get() = list.lastOrNull()?.takeIf { !it.leaving }

    val isEmpty: Boolean get() = list.isEmpty()

    fun alphaOf(layer: Layer<T>, now: Long): Float {
        val elapsed = now - layer.since
        return if (layer.leaving) OverlayMotion.fadeOut(layer.alpha0, elapsed) else OverlayMotion.fadeIn(layer.alpha0, elapsed)
    }

    /** True when nothing is fading any more. */
    fun isSettled(now: Long): Boolean =
        list.none { it.leaving } && (current?.let { alphaOf(it, now) >= 0.999f } ?: true)

    /** Replace everything with [content] at full alpha (first draw, edit-mode drops). */
    fun snap(content: T, box: Box, now: Long) {
        list.clear()
        list.add(Layer(content, box, box, now, 1f, leaving = false))
    }

    /**
     * Make [content] the current layer. The previous current layer starts fading out from the alpha
     * it has right now. A layer still fading out with equal content is promoted instead.
     */
    fun push(content: T, box: Box, now: Long) {
        val cur = current
        if (cur != null && cur.content == content) return
        if (cur != null) {
            cur.alpha0 = alphaOf(cur, now)
            cur.since = now
            cur.leaving = true
        }
        val revived = list.firstOrNull { it.leaving && it.content == content && it !== cur }
        if (revived != null) {
            list.remove(revived)
            revived.alpha0 = alphaOf(revived, now)
            revived.since = now
            revived.leaving = false
            revived.shownSince = now
            revived.fromBox = revived.box
            list.add(revived)
        } else {
            list.add(Layer(content, box, box, now, 0f, leaving = false))
        }
        prune(now)
    }

    /** Drop layers that have finished fading out; never keep more than three, shedding the faintest first. */
    fun prune(now: Long) {
        list.removeAll { it.leaving && alphaOf(it, now) <= OverlayMotion.GONE_ALPHA }
        while (list.count { it.leaving } > MAX_LEAVING) {
            val faintest = list.filter { it.leaving }.minByOrNull { alphaOf(it, now) } ?: break
            list.remove(faintest)
        }
    }

    private companion object {
        const val MAX_LEAVING = 3
    }
}
