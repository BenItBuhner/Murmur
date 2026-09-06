package app.murmur.android.overlay

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.animation.AnimationUtils
import androidx.core.graphics.ColorUtils
import app.murmur.android.dictation.DictationState
import app.murmur.android.settings.OverlayShape
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

private const val BAR_COUNT = 16
private const val MORPH_MS = 340L
private const val MOVE_MS = 240L
private const val BAR_STEP_MS = 64L
private const val SHADOW_PAD_DP = 12f
private const val NUDGE_REPEAT_DELAY_MS = 360L
private const val NUDGE_REPEAT_MS = 45L

/** Fastest finger velocity (dp/s) handed to the landing spring; wilder flings still pick the spot, they just do not overshoot more. */
private const val MAX_SPRING_VELOCITY_DP = 900f

private const val ACCENT = 0xFFFF5A36.toInt()
private const val BG_DARK = 0xF2141414.toInt()
private const val BG_SUCCESS = 0xF20F2A1C.toInt()
private const val BG_ERROR = 0xF23A1512.toInt()
private const val GREEN = 0xFF7EE2A8.toInt()
private const val RED = 0xFFFF8A70.toInt()
private const val CHIP_DARK = 0xFF2A2A31.toInt()
private const val PANEL_BG = 0xF5151519.toInt()
private const val MUTED = 0xFF9A9AA2.toInt()

/**
 * The floating dictation pill, drawn to match the desktop overlay: a dark rounded pill with a
 * pulsing red dot, live waveform, elapsed time and cancel/confirm buttons while listening; bouncing
 * dots while processing; a check or warning with a message afterwards. At rest it collapses to a
 * mic button (a wide pill or a compact circle) that lives on one of a few user-chosen *spots* near
 * the keyboard.
 *
 * At rest the button can be dragged: it follows the finger, every spot shows as a ghost with the
 * one it would land on highlighted, and on release it springs to the nearest spot (a flick reaches
 * a spot the finger did not travel all the way to). In edit mode all spots are shown and can be
 * dragged with alignment guides (the middle of the screen, another spot's row or column), locked
 * into a shared row or column, added, removed, or nudged one dp at a time.
 *
 * Every state grows out of the same anchor point and all transitions are one continuous,
 * time-based morph: size, corner radius and colour interpolate while the old and new contents
 * cross-fade. The window that hosts the view is only ever resized *before* a morph starts (to the
 * union of both shapes) and tightened *after* it settles, so the pixels of the pill never jump
 * when the window changes. Without a [host] the view is a self-contained preview.
 */
class OverlayPillView(context: Context) : View(context) {

    /** Owner of the window this view lives in; asked to move and resize it (screen coordinates). */
    fun interface Host {
        fun applyWindowFrame(frame: Box)
    }

    var host: Host? = null

    /** Embedded in the settings screen: the view's own bounds are the "screen" and the pill is centred. */
    var previewMode = false

    var onMicTap: (() -> Unit)? = null
    var onCancelTap: (() -> Unit)? = null
    var onConfirmTap: (() -> Unit)? = null
    var onEditDone: (() -> Unit)? = null
    var onEditReset: (() -> Unit)? = null

    /** The spots changed: one was moved, added, removed or re-arranged, or the button landed on another one. */
    var onLayoutChanged: ((OverlayLayout) -> Unit)? = null

    private enum class Kind { IDLE, LISTENING, PROCESSING, SUCCESS, ERROR }

    /** [restingW] is the width the contents were laid out for; [w] may be a mid-morph snapshot. */
    private data class Look(
        val kind: Kind,
        val w: Float,
        val h: Float,
        val bg: Int,
        val text: String = "",
        val restingW: Float = w
    ) {
        fun sameContent(other: Look): Boolean = kind == other.kind && text == other.text
    }

    /** Tappable pieces of the edit-mode panel. */
    private sealed interface Control {
        data object Done : Control
        data object Reset : Control
        data object Add : Control
        data object Remove : Control
        data class Select(val index: Int) : Control
        data class Arrange(val arrangement: OverlayArrangement) : Control
        data class Nudge(val dx: Int, val dy: Int) : Control
    }

    private class Hit(val control: Control, val box: Box)

    private val density = resources.displayMetrics.density
    private fun dp(v: Float): Float = v * density
    private fun sp(v: Float): Float = v * resources.displayMetrics.scaledDensity

    // ---- inputs ---------------------------------------------------------------------------------

    private var state: DictationState = DictationState.Idle
    private var shape = OverlayShape.PILL
    private var layout = OverlayLayout.DEFAULT
    private var editing = false
    private var screenW = 0f
    private var screenH = 0f
    private var keyboardTop: Float? = null

    // ---- morph model ----------------------------------------------------------------------------

    private var toLook: Look = idleLook()
    private var fromLook: Look = toLook
    private var toAx = 0f
    private var toAy = 0f
    private var fromAx = 0f
    private var fromAy = 0f
    private var curW = 0f
    private var curH = 0f
    private var curBg = BG_DARK
    private var curAx = 0f
    private var curAy = 0f
    private var curIncomingAlpha = 1f
    private var outgoingAlpha0 = 1f

    /** -1: at rest, 0: morph requested (clock starts on the first frame), otherwise the start time. */
    private var morphStart = -1L
    private var morphDuration = MORPH_MS
    private var contentSince = 0L
    private var hasDrawn = false
    private var lastFrameAt = 0L
    private var windowFrame = Box.EMPTY
    private var frameApplied = false
    private var pillBox = Box.EMPTY

    /** Landing on a spot after a drag: the anchor follows these instead of the timed morph. */
    private var springX: Spring? = null
    private var springY: Spring? = null

    // ---- continuous animation -------------------------------------------------------------------

    private val barTargets = FloatArray(BAR_COUNT + 1) { 0.06f }
    private val barLevels = FloatArray(BAR_COUNT + 1) { 0.06f }
    private var nextBarShiftAt = 0L
    private var latestLevel = 0f
    private var lastElapsedSec = 0
    private var pressed = false
    private var pressScale = 1f

    // ---- dragging (both modes) ------------------------------------------------------------------

    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    private val fling = FlingTracker()
    private var dragging = false
    private var dragArmed = false
    private var downX = 0f
    private var downY = 0f
    private var grabDx = 0f
    private var grabDy = 0f

    /** Outside of editing: where the finger holds the button (it is not on a spot until released). */
    private var dragPosition: Pair<Float, Float>? = null
    private var dragSince = 0L
    private var releasedAt = 0L

    // ---- edit mode ------------------------------------------------------------------------------

    private var guideX: Float? = null
    private var guideY: Float? = null
    private var guideXSpan = 0f to 0f
    private var guideYSpan = 0f to 0f
    private val hits = ArrayList<Hit>()
    private var pressedControl: Control? = null
    private var panelBottom = 0f
    private var layoutDirty = false
    private val nudgeRepeat = object : Runnable {
        override fun run() {
            val control = pressedControl as? Control.Nudge ?: return
            nudge(control)
            postDelayed(this, NUDGE_REPEAT_MS)
        }
    }

    // ---- paints ---------------------------------------------------------------------------------

    private val pillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = sp(13f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private val smallTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = sp(12f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private val tinyTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = sp(11f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private val badgeTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = sp(9.5f)
        typeface = Typeface.create("sans-serif", Typeface.BOLD)
        textAlign = Paint.Align.CENTER
    }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val dashPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1.2f)
        pathEffect = DashPathEffect(floatArrayOf(dp(5f), dp(5f)), 0f)
    }
    private val clipPath = Path()
    private val scratchPath = Path()
    private val scratchRect = RectF()
    private var cancelBox = Box.EMPTY
    private var confirmBox = Box.EMPTY

    // ---- public API -----------------------------------------------------------------------------

    /** Screen size and the keyboard's top edge (null when no keyboard is showing). */
    fun setScreen(widthPx: Int, heightPx: Int, keyboardTopPx: Int?) {
        if (previewMode) return
        screenW = widthPx.toFloat()
        screenH = heightPx.toFloat()
        keyboardTop = keyboardTopPx?.toFloat()
        retarget()
    }

    fun configure(shape: OverlayShape, layout: OverlayLayout) {
        val shapeChanged = shape != this.shape
        this.shape = shape
        // While a spot is being dragged this view owns the layout; the drop pushes it out.
        val layoutChanged = !dragging && !layoutDirty && layout != this.layout
        if (layoutChanged) this.layout = layout
        if (shapeChanged || layoutChanged) retarget()
    }

    fun setEditing(editing: Boolean) {
        if (this.editing == editing) return
        this.editing = editing
        cancelGesture()
        springX = null
        springY = null
        hits.clear()
        panelBottom = 0f
        retarget()
    }

    fun render(next: DictationState) {
        state = next
        when (next) {
            is DictationState.Listening -> {
                latestLevel = next.level
                lastElapsedSec = next.elapsedSec
            }
            is DictationState.Idle -> latestLevel = 0f
            else -> Unit
        }
        retarget()
    }

    // ---- looks ----------------------------------------------------------------------------------

    private fun idleLook(): Look = when (shape) {
        OverlayShape.PILL -> Look(Kind.IDLE, dp(64f), dp(36f), BG_DARK)
        OverlayShape.CIRCLE -> Look(Kind.IDLE, dp(36f), dp(36f), BG_DARK)
    }

    private fun listeningLook(): Look {
        val maxW = if (screenW > 0f) screenW - 2 * dp(OverlayGeometry.EDGE_MARGIN_DP) else Float.MAX_VALUE
        return Look(Kind.LISTENING, min(dp(232f), maxW), dp(46f), BG_DARK)
    }

    private fun lookFor(s: DictationState): Look = when (s) {
        is DictationState.Idle -> idleLook()
        is DictationState.Listening -> listeningLook()
        is DictationState.Processing -> Look(Kind.PROCESSING, textPaint.measureText(s.label) + dp(64f), dp(46f), BG_DARK, s.label)
        is DictationState.Success -> Look(Kind.SUCCESS, textPaint.measureText(s.message) + dp(56f), dp(46f), BG_SUCCESS, s.message)
        is DictationState.Error -> Look(Kind.ERROR, min(dp(300f), textPaint.measureText(s.message) + dp(56f)), dp(46f), BG_ERROR, s.message)
    }

    /** Screen-space centre of the resting button on [spot]. */
    private fun spotPoint(spot: OverlayAnchor): Pair<Float, Float> {
        val idle = idleLook()
        return OverlayGeometry.anchorPoint(spot, screenW, screenH, keyboardTop, density, idle.w, idle.h)
    }

    /** Screen-space centre of the resting button (the point every state grows out of). */
    private fun anchorPointNow(): Pair<Float, Float> {
        if (previewMode) return (screenW / 2f) to (screenH / 2f)
        dragPosition?.let { return it }
        return spotPoint(layout.active)
    }

    private fun boxFor(look: Look, ax: Float, ay: Float): Box =
        OverlayGeometry.place(ax, ay, look.w, look.h, screenW, screenH, density)

    /** Re-evaluate the target look and anchor; start a morph from wherever the pill currently is. */
    private fun retarget(animate: Boolean = true) {
        if (screenW <= 0f || screenH <= 0f) return
        val newLook = if (editing) idleLook() else lookFor(state)
        val (ax, ay) = anchorPointNow()
        val lookChanged = newLook != toLook
        val anchorChanged = abs(ax - toAx) > 0.5f || abs(ay - toAy) > 0.5f
        if (!lookChanged && !anchorChanged) return
        val now = AnimationUtils.currentAnimationTimeMillis()
        springX = null
        springY = null
        if (!hasDrawn || !animate || dragging) {
            fromLook = newLook
            toLook = newLook
            fromAx = ax
            toAx = ax
            fromAy = ay
            toAy = ay
            curW = newLook.w
            curH = newLook.h
            curBg = newLook.bg
            curAx = ax
            curAy = ay
            curIncomingAlpha = 1f
            morphStart = -1L
            if (lookChanged) contentSince = now
        } else {
            // The outgoing layer is whatever was (becoming) visible, starting at its current alpha.
            outgoingAlpha0 = if (fromLook.sameContent(toLook)) 1f else curIncomingAlpha
            fromLook = Look(toLook.kind, curW, curH, curBg, toLook.text, toLook.restingW)
            fromAx = curAx
            fromAy = curAy
            toLook = newLook
            toAx = ax
            toAy = ay
            morphStart = 0L
            morphDuration = if (lookChanged) MORPH_MS else MOVE_MS
            if (lookChanged) contentSince = now
        }
        requestFrame()
        invalidate()
    }

    /** Window frame covering both ends of the morph (or the whole screen while editing or dragging). */
    private fun requestFrame() {
        if (previewMode || host == null) {
            windowFrame = Box(0f, 0f, width.toFloat(), height.toFloat())
            return
        }
        val screen = Box(0f, 0f, screenW, screenH)
        val frame = if (editing || dragging) screen else {
            // A landing spring may overshoot its spot a little; leave it room.
            val pad = dp(SHADOW_PAD_DP) + if (springX != null) dp(20f) else 0f
            boxFor(fromLook, fromAx, fromAy).union(boxFor(toLook, toAx, toAy)).inflate(pad).intersect(screen)
        }
        applyFrame(frame)
    }

    private fun applyFrame(frame: Box) {
        if (frameApplied && frame.approximately(windowFrame)) return
        windowFrame = frame
        frameApplied = true
        host?.applyWindowFrame(frame)
    }

    /** After a morph settles, shrink the window back around the pill. */
    private fun tightenFrame() {
        if (previewMode || host == null || editing || dragging || morphStart >= 0L || springX != null) return
        val screen = Box(0f, 0f, screenW, screenH)
        applyFrame(boxFor(toLook, toAx, toAy).inflate(dp(SHADOW_PAD_DP)).intersect(screen))
    }

    // ---- measure / layout -----------------------------------------------------------------------

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(
            resolveSize(dp(300f).toInt(), widthMeasureSpec),
            resolveSize(dp(64f).toInt(), heightMeasureSpec)
        )
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (previewMode || host == null) {
            screenW = w.toFloat()
            screenH = h.toFloat()
            keyboardTop = null
            windowFrame = Box(0f, 0f, screenW, screenH)
            retarget(animate = false)
        }
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(nudgeRepeat)
        super.onDetachedFromWindow()
    }

    // ---- drawing --------------------------------------------------------------------------------

    override fun onDraw(canvas: Canvas) {
        if (screenW <= 0f || screenH <= 0f) return
        val now = AnimationUtils.currentAnimationTimeMillis()
        val dt = if (lastFrameAt == 0L) 16L else (now - lastFrameAt).coerceIn(1L, 100L)
        lastFrameAt = now

        if (morphStart == 0L) morphStart = now
        var t = 1f
        if (morphStart > 0L) {
            t = ((now - morphStart).toFloat() / morphDuration).coerceIn(0f, 1f)
            if (t >= 1f) {
                morphStart = -1L
                post { tightenFrame() }
            }
        }
        val e = easeOutCubic(t)
        curW = lerp(fromLook.w, toLook.w, e)
        curH = lerp(fromLook.h, toLook.h, e)
        curBg = ColorUtils.blendARGB(fromLook.bg, toLook.bg, e)
        val sx = springX
        val sy = springY
        if (sx != null && sy != null) {
            sx.advance(dt)
            sy.advance(dt)
            curAx = sx.position
            curAy = sy.position
            if (sx.settled && sy.settled) {
                springX = null
                springY = null
                post { tightenFrame() }
            }
        } else {
            curAx = lerp(fromAx, toAx, e)
            curAy = lerp(fromAy, toAy, e)
        }
        val crossfade = morphStart >= 0L && !fromLook.sameContent(toLook)
        curIncomingAlpha = if (crossfade) smoothstep(0.32f, 1f, t) else 1f
        val outgoingAlpha = if (crossfade) outgoingAlpha0 * (1f - smoothstep(0f, 0.42f, t)) else 0f
        if (morphStart < 0L && toLook.kind != Kind.LISTENING) resetBars()

        pressScale = approach(pressScale, pressTarget(), dt, 55f)

        // Everything below is in screen coordinates.
        canvas.save()
        canvas.translate(-windowFrame.left, -windowFrame.top)

        val box = OverlayGeometry.place(curAx, curAy, curW, curH, screenW, screenH, density)
        pillBox = box
        val drawn = if (abs(pressScale - 1f) > 0.001f) {
            Box.centered(box.centerX, box.centerY, box.width * pressScale, box.height * pressScale)
        } else box

        if (editing) {
            drawGhostSpots(canvas)
            drawEditGuides(canvas, now, drawn)
        } else if (dragging || (releasedAt > 0L && now - releasedAt < FLICK_GHOST_FADE_MS)) {
            drawFlickTargets(canvas, now)
        }

        val radius = drawn.height / 2f
        pillPaint.color = curBg
        pillPaint.setShadowLayer(dp(if (dragging) 12f else 6f), 0f, dp(if (dragging) 5f else 2f), 0x59000000)
        scratchRect.set(drawn.left, drawn.top, drawn.right, drawn.bottom)
        canvas.drawRoundRect(scratchRect, radius, radius, pillPaint)
        pillPaint.clearShadowLayer()

        clipPath.rewind()
        clipPath.addRoundRect(scratchRect, radius, radius, Path.Direction.CW)

        // Hairline ring (as on the desktop pill) so the button stays legible on dark keyboards.
        strokePaint.color = 0x1AFFFFFF
        strokePaint.strokeWidth = dp(1f)
        scratchRect.inset(dp(0.5f), dp(0.5f))
        canvas.drawRoundRect(scratchRect, radius - dp(0.5f), radius - dp(0.5f), strokePaint)

        if (crossfade && outgoingAlpha > 0.01f) {
            drawLayer(canvas, drawn, fromLook, outgoingAlpha, lerp(1f, 0.9f, smoothstep(0f, 0.42f, t)), now, dt)
        }
        if (curIncomingAlpha > 0.01f) {
            drawLayer(canvas, drawn, toLook, curIncomingAlpha, if (crossfade) lerp(0.9f, 1f, curIncomingAlpha) else 1f, now, dt)
        }
        if (editing) {
            drawBadge(canvas, drawn, layout.activeIndex + 1, true)
            drawEditChrome(canvas, drawn)
        }

        canvas.restore()
        hasDrawn = true
        if (isAnimating(now)) postInvalidateOnAnimation()
    }

    private fun drawLayer(canvas: Canvas, box: Box, look: Look, alpha: Float, scale: Float, now: Long, dt: Long) {
        val full = alpha >= 0.999f && abs(scale - 1f) < 0.001f
        canvas.save()
        canvas.clipPath(clipPath)
        if (!full) {
            canvas.saveLayerAlpha(box.left, box.top, box.right, box.bottom, (alpha * 255f).toInt().coerceIn(0, 255))
            canvas.scale(scale, scale, box.centerX, box.centerY)
        }
        when (look.kind) {
            Kind.IDLE -> drawIdle(canvas, box)
            Kind.LISTENING -> drawListening(canvas, box, now, dt)
            Kind.PROCESSING -> drawProcessing(canvas, box, look.text, now)
            Kind.SUCCESS -> drawMessage(canvas, box, look, GREEN, true, now)
            Kind.ERROR -> drawMessage(canvas, box, look, RED, false, now)
        }
        if (!full) canvas.restore()
        canvas.restore()
    }

    private fun drawIdle(canvas: Canvas, box: Box) {
        val cx = box.centerX
        val cy = box.centerY
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = dp(1.8f)
        val mw = dp(4.4f)
        val mh = dp(7.5f)
        paint.color = ACCENT
        canvas.drawRoundRect(cx - mw / 2, cy - mh + dp(1f), cx + mw / 2, cy + dp(2.4f), mw / 2, mw / 2, paint)
        canvas.drawArc(cx - dp(7f), cy - dp(4.5f), cx + dp(7f), cy + dp(6.5f), 15f, 150f, false, strokePaint)
        canvas.drawLine(cx, cy + dp(6.5f), cx, cy + dp(9f), strokePaint)
    }

    private fun drawListening(canvas: Canvas, box: Box, now: Long, dt: Long) {
        val cy = box.centerY
        val btnR = dp(14f)
        val cancelCx = box.left + dp(24f)
        cancelBox = Box.centered(cancelCx, cy, btnR * 2, btnR * 2)
        paint.color = 0x1FFFFFFF
        canvas.drawCircle(cancelCx, cy, btnR - dp(2f), paint)
        strokePaint.color = 0xFFCCCCCC.toInt()
        strokePaint.strokeWidth = dp(2f)
        val xr = dp(4.5f)
        canvas.drawLine(cancelCx - xr, cy - xr, cancelCx + xr, cy + xr, strokePaint)
        canvas.drawLine(cancelCx - xr, cy + xr, cancelCx + xr, cy - xr, strokePaint)

        val dotCx = box.left + dp(52f)
        val pulse = 1f + 0.18f * sin(2.0 * PI * (now % 1200L) / 1200.0).toFloat()
        paint.color = ACCENT
        canvas.drawCircle(dotCx, cy, dp(3.6f) * pulse, paint)

        // Conveyor-belt waveform: bars slide left continuously between level samples.
        advanceBars(now, dt)
        val barW = dp(2.6f)
        val gap = dp(2.2f)
        val pitch = barW + gap
        val barsLeft = dotCx + dp(12f)
        val barsRight = barsLeft + BAR_COUNT * pitch - gap
        val frac = 1f - ((nextBarShiftAt - now).toFloat() / BAR_STEP_MS).coerceIn(0f, 1f)
        canvas.save()
        canvas.clipRect(barsLeft - dp(1f), box.top, barsRight + dp(1f), box.bottom)
        paint.color = Color.WHITE
        for (i in 0..BAR_COUNT) {
            val v = barLevels[i]
            val bh = max(dp(3f), v * dp(20f))
            var a = 0.55f + v * 0.45f
            if (i == 0) a *= 1f - frac
            if (i == BAR_COUNT) a *= frac
            paint.alpha = (a * 255f).toInt().coerceIn(0, 255)
            val x = barsLeft + (i - frac) * pitch
            canvas.drawRoundRect(x, cy - bh / 2, x + barW, cy + bh / 2, barW / 2, barW / 2, paint)
        }
        paint.alpha = 255
        canvas.restore()

        textPaint.color = 0xB3FFFFFF.toInt()
        canvas.drawText(elapsedText(), barsRight + dp(8f), cy + textPaint.textSize / 2.8f, textPaint)
        textPaint.color = Color.WHITE

        val confirmCx = box.right - dp(24f)
        confirmBox = Box.centered(confirmCx, cy, btnR * 2, btnR * 2)
        paint.color = ACCENT
        canvas.drawCircle(confirmCx, cy, btnR - dp(2f), paint)
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = dp(2.2f)
        canvas.drawLine(confirmCx - dp(4.6f), cy + dp(0.5f), confirmCx - dp(1f), cy + dp(4f), strokePaint)
        canvas.drawLine(confirmCx - dp(1f), cy + dp(4f), confirmCx + dp(5f), cy - dp(3.5f), strokePaint)
    }

    private fun advanceBars(now: Long, dt: Long) {
        if (nextBarShiftAt == 0L || now - nextBarShiftAt > 1000L) nextBarShiftAt = now + BAR_STEP_MS
        var shifts = 0
        while (now >= nextBarShiftAt && shifts < 4) {
            System.arraycopy(barTargets, 1, barTargets, 0, BAR_COUNT)
            System.arraycopy(barLevels, 1, barLevels, 0, BAR_COUNT)
            barTargets[BAR_COUNT] = max(0.08f, min(1f, latestLevel + (Math.random().toFloat() - 0.5f) * 0.08f))
            barLevels[BAR_COUNT] = barTargets[BAR_COUNT] * 0.4f
            nextBarShiftAt += BAR_STEP_MS
            shifts++
        }
        val k = 1f - exp(-dt / 45f)
        for (i in 0..BAR_COUNT) barLevels[i] += (barTargets[i] - barLevels[i]) * k
    }

    private fun resetBars() {
        if (nextBarShiftAt == 0L) return
        barTargets.fill(0.06f)
        barLevels.fill(0.06f)
        nextBarShiftAt = 0L
    }

    private var elapsedTextFor = -1
    private var elapsedTextCache = "0:00"

    private fun elapsedText(): String {
        val elapsed = (state as? DictationState.Listening)?.elapsedSec ?: lastElapsedSec
        if (elapsed != elapsedTextFor) {
            elapsedTextFor = elapsed
            elapsedTextCache = "%d:%02d".format(elapsed / 60, elapsed % 60)
        }
        return elapsedTextCache
    }

    private fun pressTarget(): Float = when {
        dragging -> 1.08f
        !pressed -> 1f
        editing -> 1.08f
        else -> 0.93f
    }

    private fun drawProcessing(canvas: Canvas, box: Box, label: String, now: Long) {
        val cy = box.centerY
        var x = box.left + dp(20f)
        paint.color = Color.WHITE
        val phase = 2.0 * PI * (now % 1100L) / 1100.0
        for (i in 0 until 3) {
            val bounce = max(0.0, sin(phase - i * 0.9)).toFloat() * dp(3.5f)
            paint.alpha = (140 + 115 * (bounce / dp(3.5f))).toInt().coerceIn(0, 255)
            canvas.drawCircle(x, cy - bounce + dp(1.5f), dp(2.6f), paint)
            x += dp(10f)
        }
        paint.alpha = 255
        textPaint.color = 0xD9FFFFFF.toInt()
        canvas.drawText(label, x + dp(4f), cy + textPaint.textSize / 2.8f, textPaint)
        textPaint.color = Color.WHITE
    }

    private fun drawMessage(canvas: Canvas, box: Box, look: Look, color: Int, check: Boolean, now: Long) {
        val cy = box.centerY
        val iconCx = box.left + dp(22f)
        strokePaint.color = color
        strokePaint.strokeWidth = dp(2.4f)
        if (check) {
            // The tick draws itself in once the pill has (mostly) taken its new shape.
            val p = smoothstep(0f, 1f, ((now - contentSince - 120L).toFloat() / 260f).coerceIn(0f, 1f))
            val ax = iconCx - dp(5f)
            val ay = cy
            val bx = iconCx - dp(1f)
            val by = cy + dp(4f)
            val cx2 = iconCx + dp(6f)
            val cy2 = cy - dp(4f)
            val first = (p / 0.4f).coerceIn(0f, 1f)
            val second = ((p - 0.4f) / 0.6f).coerceIn(0f, 1f)
            if (first > 0f) canvas.drawLine(ax, ay, lerp(ax, bx, first), lerp(ay, by, first), strokePaint)
            if (second > 0f) canvas.drawLine(bx, by, lerp(bx, cx2, second), lerp(by, cy2, second), strokePaint)
        } else {
            strokePaint.strokeWidth = dp(2f)
            canvas.drawCircle(iconCx, cy, dp(7f), strokePaint)
            canvas.drawLine(iconCx, cy - dp(3.5f), iconCx, cy + dp(0.8f), strokePaint)
            paint.color = color
            canvas.drawCircle(iconCx, cy + dp(3.6f), dp(1f), paint)
        }
        // Fit the text to the pill's resting width, not the box mid-morph: while the pill is still
        // growing or shrinking the pill's outline clips it instead of re-ellipsizing every frame.
        var msg = look.text
        val maxWidth = look.restingW - dp(48f)
        if (textPaint.measureText(msg) > maxWidth) {
            while (msg.length > 4 && textPaint.measureText("$msg…") > maxWidth) msg = msg.dropLast(1)
            msg = "$msg…"
        }
        canvas.drawText(msg, box.left + dp(38f), cy + textPaint.textSize / 2.8f, textPaint)
    }

    // ---- flick between spots (normal mode) ------------------------------------------------------

    /** While the button is held, every spot shows where it can land; the nearest one lights up. */
    private fun drawFlickTargets(canvas: Canvas, now: Long) {
        val idle = idleLook()
        val points = layout.spots.map { spotPoint(it) }
        val candidate = OverlayGeometry.nearestSpot(points, curAx, curAy)
        val fadeIn = smoothstep(0f, 1f, ((now - dragSince).toFloat() / 140f).coerceIn(0f, 1f))
        val fadeOut = if (dragging) 1f else 1f - smoothstep(0f, 1f, ((now - releasedAt).toFloat() / FLICK_GHOST_FADE_MS).coerceIn(0f, 1f))
        val alpha = (fadeIn * fadeOut).coerceIn(0f, 1f)
        if (alpha <= 0.01f) return
        for ((i, p) in points.withIndex()) {
            val box = boxFor(idle, p.first, p.second)
            val r = box.height / 2f
            scratchRect.set(box.left, box.top, box.right, box.bottom)
            if (i == candidate) {
                paint.color = ColorUtils.setAlphaComponent(ACCENT, (0x48 * alpha).toInt())
                canvas.drawRoundRect(scratchRect, r, r, paint)
                strokePaint.color = ColorUtils.setAlphaComponent(ACCENT, (0xE6 * alpha).toInt())
                strokePaint.strokeWidth = dp(2f)
                canvas.drawRoundRect(scratchRect, r, r, strokePaint)
            } else {
                paint.color = ColorUtils.setAlphaComponent(0x141414, (0x40 * alpha).toInt())
                canvas.drawRoundRect(scratchRect, r, r, paint)
                dashPaint.color = ColorUtils.setAlphaComponent(Color.WHITE, (0x8C * alpha).toInt())
                canvas.drawRoundRect(scratchRect, r, r, dashPaint)
            }
        }
    }

    private fun canFlick(): Boolean =
        !previewMode && host != null && toLook.kind == Kind.IDLE && fromLook.kind == Kind.IDLE && layout.spots.isNotEmpty()

    private fun startFlick(x: Float, y: Float) {
        dragging = true
        pressed = false
        dragSince = AnimationUtils.currentAnimationTimeMillis()
        releasedAt = 0L
        springX = null
        springY = null
        morphStart = -1L
        requestFrame()
        dragFree(x, y)
    }

    private fun dragFree(x: Float, y: Float) {
        val idle = idleLook()
        val margin = dp(OverlayGeometry.EDGE_MARGIN_DP)
        val nx = OverlayGeometry.clampCenter(x - grabDx, idle.w, screenW, margin)
        val ny = OverlayGeometry.clampCenter(y - grabDy, idle.h, screenH, margin)
        dragPosition = nx to ny
        fromAx = nx
        toAx = nx
        fromAy = ny
        toAy = ny
        curAx = nx
        curAy = ny
        invalidate()
    }

    /** The finger let go: pick the spot it was heading for and spring onto it, carrying the finger's momentum. */
    private fun endFlick() {
        val (vx, vy) = fling.velocity()
        val points = layout.spots.map { spotPoint(it) }
        val index = OverlayGeometry.nearestSpot(points, curAx, curAy, vx, vy, maxLookaheadPx = screenW * 0.4f)
        dragging = false
        dragPosition = null
        releasedAt = AnimationUtils.currentAnimationTimeMillis()
        val next = layout.activated(index)
        if (next != layout) {
            layout = next
            onLayoutChanged?.invoke(next)
        }
        val (tx, ty) = points[index]
        val maxV = dp(MAX_SPRING_VELOCITY_DP)
        springX = Spring(curAx, vx.coerceIn(-maxV, maxV)).apply { target = tx }
        springY = Spring(curAy, vy.coerceIn(-maxV, maxV)).apply { target = ty }
        fromAx = curAx
        fromAy = curAy
        toAx = tx
        toAy = ty
        morphStart = -1L
        performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
        requestFrame()
        invalidate()
    }

    // ---- edit mode drawing ----------------------------------------------------------------------

    /** Every spot but the selected one, as a numbered outline the user can tap or drag. */
    private fun drawGhostSpots(canvas: Canvas) {
        val idle = idleLook()
        for ((i, spot) in layout.spots.withIndex()) {
            if (i == layout.activeIndex) continue
            val (px, py) = spotPoint(spot)
            val box = boxFor(idle, px, py)
            val r = box.height / 2f
            scratchRect.set(box.left, box.top, box.right, box.bottom)
            paint.color = 0xA6141414.toInt()
            canvas.drawRoundRect(scratchRect, r, r, paint)
            dashPaint.color = 0x80FFFFFF.toInt()
            canvas.drawRoundRect(scratchRect, r, r, dashPaint)
            canvas.saveLayerAlpha(box.left, box.top, box.right, box.bottom, 110)
            drawIdle(canvas, box)
            canvas.restore()
            drawBadge(canvas, box, i + 1, false)
        }
    }

    private fun drawBadge(canvas: Canvas, box: Box, number: Int, active: Boolean) {
        val r = dp(8f)
        val cx = box.right - dp(3f)
        val cy = box.top + dp(3f)
        paint.color = if (active) ACCENT else 0xFF3C3C45.toInt()
        canvas.drawCircle(cx, cy, r, paint)
        strokePaint.color = 0x33000000
        strokePaint.strokeWidth = dp(1f)
        canvas.drawCircle(cx, cy, r, strokePaint)
        canvas.drawText(number.toString(), cx, cy + badgeTextPaint.textSize / 2.8f, badgeTextPaint)
    }

    private fun drawEditGuides(canvas: Canvas, now: Long, button: Box) {
        // Where the listening pill will land when the button is tapped from here.
        val listening = listeningLook()
        val ghost = OverlayGeometry.place(curAx, curAy, listening.w, listening.h, screenW, screenH, density)
        scratchRect.set(ghost.left, ghost.top, ghost.right, ghost.bottom)
        scratchPath.rewind()
        scratchPath.addRoundRect(scratchRect, ghost.height / 2f, ghost.height / 2f, Path.Direction.CW)
        dashPaint.color = 0x59FFFFFF
        canvas.drawPath(scratchPath, dashPaint)

        // Alignment guides the drag is snapped to: the middle of the screen or another spot's row/column.
        dashPaint.color = 0xB3FF5A36.toInt()
        guideX?.let { gx -> canvas.drawLine(gx, guideXSpan.first, gx, guideXSpan.second, dashPaint) }
        guideY?.let { gy -> canvas.drawLine(guideYSpan.first, gy, guideYSpan.second, gy, dashPaint) }

        // Pulsing halo hugging the button's outline (a ring for the circle, a capsule for the pill).
        val pulse = sin(2.0 * PI * (now % 1600L) / 1600.0).toFloat()
        val pad = dp(7f) + dp(2.5f) * pulse
        val halo = button.inflate(pad)
        strokePaint.color = ColorUtils.setAlphaComponent(ACCENT, (150 + 60 * pulse).toInt().coerceIn(0, 255))
        strokePaint.strokeWidth = dp(2f)
        scratchRect.set(halo.left, halo.top, halo.right, halo.bottom)
        canvas.drawRoundRect(scratchRect, halo.height / 2f, halo.height / 2f, strokePaint)
    }

    private fun drawEditChrome(canvas: Canvas, button: Box) {
        drawEditPanel(canvas)

        // Live readout of the selected spot, next to it: this is the number that gets stored.
        val hint = layout.active.describe(short = true)
        val hintW = smallTextPaint.measureText(hint) + dp(24f)
        val hintH = dp(28f)
        var hintTop = button.top - dp(16f) - hintH
        if (hintTop < panelBottom + dp(8f)) hintTop = button.bottom + dp(16f)
        val hintLeft = OverlayGeometry.clampCenter(button.centerX, hintW, screenW, dp(8f)) - hintW / 2f
        drawChip(canvas, Box(hintLeft, hintTop, hintLeft + hintW, hintTop + hintH), hint, 0xE6202024.toInt(), 0xE6FFFFFF.toInt(), false)
    }

    /** The toolbar at the top of the screen: spots, arrangement, nudge pad, Reset and Done. */
    private fun drawEditPanel(canvas: Canvas) {
        hits.clear()
        val pad = dp(12f)
        val gap = dp(6f)
        val rowGap = dp(8f)
        val chipH = dp(34f)
        val captionH = dp(14f)
        val left = dp(12f)
        val right = screenW - dp(12f)
        val top = max(statusBarInset(), dp(24f)) + dp(8f)
        panelBottom = top + pad * 2 + chipH * 3 + rowGap * 3 + captionH

        pillPaint.color = PANEL_BG
        pillPaint.setShadowLayer(dp(10f), 0f, dp(4f), 0x66000000)
        scratchRect.set(left, top, right, panelBottom)
        canvas.drawRoundRect(scratchRect, dp(20f), dp(20f), pillPaint)
        pillPaint.clearShadowLayer()
        strokePaint.color = 0x1FFFFFFF
        strokePaint.strokeWidth = dp(1f)
        canvas.drawRoundRect(scratchRect, dp(20f), dp(20f), strokePaint)

        // Row 1: which spot, add / remove, Done.
        var y = top + pad
        var x = left + pad
        for (i in layout.spots.indices) {
            x = drawControl(canvas, x, y, chipH, (i + 1).toString(), i == layout.activeIndex, Control.Select(i), square = true) + gap
        }
        if (layout.canAdd) x = drawControl(canvas, x, y, chipH, "+", false, Control.Add, square = true) + gap
        if (layout.canRemove) drawControl(canvas, x, y, chipH, "Remove", false, Control.Remove)
        drawControlRightAligned(canvas, right - pad, y, chipH, "Done", true, Control.Done)

        // Row 2: how the spots relate to each other.
        y += chipH + rowGap
        x = left + pad
        for ((arrangement, label) in ARRANGEMENT_LABELS) {
            x = drawControl(canvas, x, y, chipH, label, layout.arrangement == arrangement, Control.Arrange(arrangement)) + gap
        }

        // Row 3: nudge pad, Reset.
        y += chipH + rowGap
        x = left + pad
        for ((dx, dy) in NUDGES) x = drawNudgeControl(canvas, x, y, chipH, dx, dy) + gap
        tinyTextPaint.color = MUTED
        canvas.drawText("Nudge 1 dp", x + dp(4f), y + chipH / 2f + tinyTextPaint.textSize / 2.8f, tinyTextPaint)
        drawControlRightAligned(canvas, right - pad, y, chipH, "Reset", false, Control.Reset)

        // Caption.
        y += chipH + rowGap
        val caption = when (layout.arrangement) {
            OverlayArrangement.SAME_ROW -> "Drag a spot to move it · the whole row moves up and down together"
            OverlayArrangement.SAME_COLUMN -> "Drag a spot to move it · the whole column moves sideways together"
            OverlayArrangement.FREE -> "Drag a spot to move it · tap another spot to select it"
        }
        canvas.drawText(fitText(caption, tinyTextPaint, right - left - pad * 2), left + pad, y + tinyTextPaint.textSize, tinyTextPaint)
        tinyTextPaint.color = Color.WHITE
    }

    private fun drawControl(canvas: Canvas, x: Float, y: Float, h: Float, label: String, selected: Boolean, control: Control, square: Boolean = false): Float {
        val w = if (square) h else smallTextPaint.measureText(label) + dp(28f)
        val box = Box(x, y, x + w, y + h)
        hits += Hit(control, box)
        drawChip(canvas, box, label, if (selected) ACCENT else CHIP_DARK, Color.WHITE, pressedControl == control)
        return box.right
    }

    private fun drawControlRightAligned(canvas: Canvas, right: Float, y: Float, h: Float, label: String, accent: Boolean, control: Control) {
        val w = smallTextPaint.measureText(label) + dp(32f)
        val box = Box(right - w, y, right, y + h)
        hits += Hit(control, box)
        drawChip(canvas, box, label, if (accent) ACCENT else CHIP_DARK, Color.WHITE, pressedControl == control)
    }

    private fun drawNudgeControl(canvas: Canvas, x: Float, y: Float, h: Float, dx: Int, dy: Int): Float {
        val control = Control.Nudge(dx, dy)
        val box = Box(x, y, x + h, y + h)
        hits += Hit(control, box)
        drawChip(canvas, box, "", CHIP_DARK, Color.WHITE, pressedControl == control)
        // A chevron pointing the way the spot will move.
        val cx = box.centerX
        val cy = box.centerY
        val a = dp(4.5f)
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = dp(2f)
        scratchPath.rewind()
        if (dx != 0) {
            val tip = cx + dx * a * 0.6f
            val tail = cx - dx * a * 0.6f
            scratchPath.moveTo(tail, cy - a)
            scratchPath.lineTo(tip, cy)
            scratchPath.lineTo(tail, cy + a)
        } else {
            val tip = cy + dy * a * 0.6f
            val tail = cy - dy * a * 0.6f
            scratchPath.moveTo(cx - a, tail)
            scratchPath.lineTo(cx, tip)
            scratchPath.lineTo(cx + a, tail)
        }
        canvas.drawPath(scratchPath, strokePaint)
        return box.right
    }

    private fun drawChip(canvas: Canvas, box: Box, label: String, bg: Int, fg: Int, isPressed: Boolean) {
        val drawn = if (isPressed) Box.centered(box.centerX, box.centerY, box.width * 0.94f, box.height * 0.94f) else box
        val r = drawn.height / 2f
        pillPaint.color = bg
        pillPaint.setShadowLayer(dp(4f), 0f, dp(1.5f), 0x40000000)
        scratchRect.set(drawn.left, drawn.top, drawn.right, drawn.bottom)
        canvas.drawRoundRect(scratchRect, r, r, pillPaint)
        pillPaint.clearShadowLayer()
        strokePaint.color = 0x1FFFFFFF
        strokePaint.strokeWidth = dp(1f)
        canvas.drawRoundRect(scratchRect, r, r, strokePaint)
        if (label.isNotEmpty()) {
            smallTextPaint.color = fg
            canvas.drawText(label, drawn.centerX - smallTextPaint.measureText(label) / 2f, drawn.centerY + smallTextPaint.textSize / 2.8f, smallTextPaint)
            smallTextPaint.color = Color.WHITE
        }
    }

    private fun fitText(text: String, p: Paint, maxWidth: Float): String {
        if (p.measureText(text) <= maxWidth) return text
        var s = text
        while (s.length > 4 && p.measureText("$s…") > maxWidth) s = s.dropLast(1)
        return "$s…"
    }

    private fun statusBarInset(): Float {
        val insets = rootWindowInsets ?: return dp(24f)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            insets.getInsets(WindowInsets.Type.statusBars()).top.toFloat()
        } else {
            @Suppress("DEPRECATION")
            insets.systemWindowInsetTop.toFloat()
        }
    }

    // ---- animation helpers ----------------------------------------------------------------------

    private fun isAnimating(now: Long): Boolean {
        if (morphStart >= 0L || editing || dragging || springX != null) return true
        if (releasedAt > 0L && now - releasedAt < FLICK_GHOST_FADE_MS) return true
        if (abs(pressScale - pressTarget()) > 0.002f) return true
        val kind = toLook.kind
        if (kind == Kind.LISTENING || kind == Kind.PROCESSING) return true
        return kind == Kind.SUCCESS && now - contentSince < 500L
    }

    private fun easeOutCubic(t: Float): Float {
        val u = 1f - t
        return 1f - u * u * u
    }

    private fun smoothstep(a: Float, b: Float, x: Float): Float {
        if (b <= a) return if (x >= b) 1f else 0f
        val t = ((x - a) / (b - a)).coerceIn(0f, 1f)
        return t * t * (3f - 2f * t)
    }

    private fun lerp(a: Float, b: Float, t: Float): Float = a + (b - a) * t

    /** Exponential approach with a time constant in milliseconds; frame-rate independent. */
    private fun approach(current: Float, target: Float, dtMs: Long, tauMs: Float): Float {
        if (abs(target - current) < 0.0005f) return target
        return current + (target - current) * (1f - exp(-dtMs / tauMs))
    }

    // ---- touch ----------------------------------------------------------------------------------

    override fun onTouchEvent(event: MotionEvent): Boolean {
        // Screen coordinates: the window moves and grows underneath a drag, view coordinates would jump with it.
        val x = event.rawX
        val y = event.rawY
        if (editing) return onEditTouch(event, x, y)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (!pillBox.inflate(dp(6f)).contains(x, y)) return false
                pressed = true
                downX = x
                downY = y
                grabDx = x - curAx
                grabDy = y - curAy
                fling.reset()
                fling.add(event.eventTime, x, y)
                invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                fling.add(event.eventTime, x, y)
                if (dragging) {
                    dragFree(x, y)
                } else if (pressed && canFlick() && hypot(x - downX, y - downY) > touchSlop) {
                    startFlick(x, y)
                } else if (pressed && !pillBox.inflate(dp(28f)).contains(x, y)) {
                    pressed = false
                    invalidate()
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                fling.add(event.eventTime, x, y)
                if (dragging) {
                    endFlick()
                } else {
                    val fire = pressed
                    pressed = false
                    invalidate()
                    if (fire) tap(x, y)
                }
                performClick()
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                if (dragging) endFlick()
                pressed = false
                invalidate()
                return true
            }
        }
        return false
    }

    private fun tap(x: Float, y: Float) {
        when (toLook.kind) {
            Kind.IDLE -> onMicTap?.invoke()
            Kind.LISTENING -> if (cancelBox.inflate(dp(4f)).contains(x, y)) onCancelTap?.invoke() else onConfirmTap?.invoke()
            else -> Unit
        }
    }

    private fun onEditTouch(event: MotionEvent, x: Float, y: Float): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = x
                downY = y
                pressedControl = hits.firstOrNull { it.box.contains(x, y) }?.control
                val nudgeControl = pressedControl as? Control.Nudge
                if (nudgeControl != null) {
                    nudge(nudgeControl)
                    postDelayed(nudgeRepeat, NUDGE_REPEAT_DELAY_MS)
                } else if (pressedControl == null) {
                    val index = spotAt(x, y)
                    if (index >= 0) {
                        if (index != layout.activeIndex) {
                            layout = layout.activated(index)
                            layoutDirty = true
                            retarget()
                        }
                        val (px, py) = spotPoint(layout.active)
                        grabDx = x - px
                        grabDy = y - py
                        dragArmed = true
                        pressed = true
                    }
                }
                invalidate()
            }
            MotionEvent.ACTION_MOVE -> {
                if (dragging) {
                    dragSpotTo(x - grabDx, y - grabDy)
                } else if (dragArmed && hypot(x - downX, y - downY) > touchSlop) {
                    dragArmed = false
                    dragging = true
                    pressed = false
                    dragSpotTo(x - grabDx, y - grabDy)
                }
            }
            MotionEvent.ACTION_UP -> {
                if (dragging) {
                    finishSpotDrag()
                } else {
                    val control = pressedControl
                    if (control != null && control !is Control.Nudge && hits.any { it.control == control && it.box.contains(x, y) }) {
                        activate(control)
                    }
                }
                endEditGesture()
                performClick()
            }
            MotionEvent.ACTION_CANCEL -> {
                if (dragging) finishSpotDrag()
                endEditGesture()
            }
        }
        return true
    }

    private fun endEditGesture() {
        removeCallbacks(nudgeRepeat)
        pressedControl = null
        dragArmed = false
        dragging = false
        pressed = false
        pushLayout()
        invalidate()
    }

    private fun cancelGesture() {
        removeCallbacks(nudgeRepeat)
        if (dragging && !editing) dragPosition = null
        dragging = false
        dragArmed = false
        pressed = false
        pressedControl = null
        guideX = null
        guideY = null
        releasedAt = 0L
        pushLayout()
    }

    /** Hand a locally edited layout to the owner once the gesture that changed it is over. */
    private fun pushLayout() {
        if (!layoutDirty) return
        layoutDirty = false
        onLayoutChanged?.invoke(layout)
    }

    /** Index of the spot under (x, y): the selected one wins when spots overlap. */
    private fun spotAt(x: Float, y: Float): Int {
        val reach = dp(16f)
        if (pillBox.inflate(reach).contains(x, y)) return layout.activeIndex
        val idle = idleLook()
        for ((i, spot) in layout.spots.withIndex()) {
            if (i == layout.activeIndex) continue
            val (px, py) = spotPoint(spot)
            if (boxFor(idle, px, py).inflate(reach).contains(x, y)) return i
        }
        return -1
    }

    /**
     * Move the selected spot to put its centre at (cx, cy), pulled onto alignment guides: the
     * middle of the screen and the rows and columns of the other spots (never one that would stack
     * it on top of another spot). Under a row or column lock the other spots move with it.
     */
    private fun dragSpotTo(cx: Float, cy: Float) {
        val idle = idleLook()
        val margin = dp(OverlayGeometry.EDGE_MARGIN_DP)
        val others = layout.spots.indices.filter { it != layout.activeIndex }.map { spotPoint(layout.spots[it]) }
        val stackGap = max(idle.w, idle.h) * 1.5f
        val guidesX = mutableListOf(screenW / 2f)
        val guidesY = mutableListOf<Float>()
        for ((ox, oy) in others) {
            if (abs(oy - cy) > stackGap) guidesX += ox
            if (abs(ox - cx) > stackGap) guidesY += oy
        }
        val snap = OverlayGeometry.snapToGuides(cx, cy, guidesX, guidesY, density)
        val minY = if (panelBottom > 0f) panelBottom + idle.h / 2f + dp(8f) else 0f
        val nx = OverlayGeometry.clampCenter(snap.x, idle.w, screenW, margin)
        val ny = max(minY, OverlayGeometry.clampCenter(snap.y, idle.h, screenH, margin))

        val onX = snap.guideX?.takeIf { abs(nx - it) < 0.5f }
        val onY = snap.guideY?.takeIf { abs(ny - it) < 0.5f }
        if ((onX != null && guideX == null) || (onY != null && guideY == null)) {
            performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        }
        guideX = onX
        guideY = onY
        if (onX != null) {
            val ys = others.filter { abs(it.first - onX) < 1f }.map { it.second } + ny
            val reach = if (ys.size > 1) dp(36f) else dp(48f) + idle.h / 2f
            guideXSpan = (ys.min() - reach) to (ys.max() + reach)
        }
        if (onY != null) {
            val xs = others.filter { abs(it.second - onY) < 1f }.map { it.first } + nx
            guideYSpan = (xs.min() - dp(36f)) to (xs.max() + dp(36f))
        }

        layout = layout.moved(layout.activeIndex, OverlayGeometry.anchorFor(nx, ny, screenW, screenH, keyboardTop, density))
        layoutDirty = true
        retarget()
    }

    private fun finishSpotDrag() {
        dragging = false
        guideX = null
        guideY = null
        retarget(animate = false)
    }

    /** Move the selected spot by whole dp; the row or column follows under a lock. */
    private fun nudge(control: Control.Nudge) {
        val idle = idleLook()
        val margin = dp(OverlayGeometry.EDGE_MARGIN_DP)
        val (px, py) = spotPoint(layout.active)
        val minY = if (panelBottom > 0f) panelBottom + idle.h / 2f + dp(8f) else 0f
        val nx = OverlayGeometry.clampCenter(px + control.dx * density, idle.w, screenW, margin)
        val ny = max(minY, OverlayGeometry.clampCenter(py + control.dy * density, idle.h, screenH, margin))
        layout = layout.moved(layout.activeIndex, OverlayGeometry.anchorFor(nx, ny, screenW, screenH, keyboardTop, density))
        layoutDirty = true
        retarget(animate = false)
    }

    private fun activate(control: Control) {
        when (control) {
            Control.Done -> onEditDone?.invoke()
            Control.Reset -> onEditReset?.invoke()
            Control.Add -> layout.added()?.let { changeLayout(it) }
            Control.Remove -> layout.removed(layout.activeIndex)?.let { changeLayout(it) }
            is Control.Select -> changeLayout(layout.activated(control.index))
            is Control.Arrange -> changeLayout(layout.arranged(control.arrangement))
            is Control.Nudge -> Unit
        }
    }

    private fun changeLayout(next: OverlayLayout) {
        if (next == layout) return
        layout = next
        layoutDirty = true
        retarget()
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private companion object {
        const val FLICK_GHOST_FADE_MS = 220L
        val NUDGES = listOf(-1 to 0, 1 to 0, 0 to -1, 0 to 1)
        val ARRANGEMENT_LABELS = listOf(
            OverlayArrangement.FREE to "Free",
            OverlayArrangement.SAME_ROW to "Same row",
            OverlayArrangement.SAME_COLUMN to "Same column"
        )
    }
}
