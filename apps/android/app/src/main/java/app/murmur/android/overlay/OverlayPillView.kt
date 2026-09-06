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
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.animation.AnimationUtils
import androidx.core.graphics.ColorUtils
import app.murmur.android.dictation.DictationState
import app.murmur.android.settings.OverlayShape
import app.murmur.android.ui.theme.Oklch
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

private const val BAR_COUNT = 16
private const val MORPH_MS = 340L
private const val MOVE_MS = 240L
private const val BAR_STEP_MS = 64L
private const val SHADOW_PAD_DP = 12f

/** Height of every state except the resting button. */
private const val TALL_DP = 46f

/** Widest a message pill gets (long error texts are ellipsized to fit). */
private const val MESSAGE_MAX_W_DP = 300f

/** How far outside the pill a touch still counts; the touch window is padded by this. */
private const val TOUCH_PAD_DP = 6f

/** The pulsing "recording" dot: a fixed red-orange, whatever the theme, because that is what it means. */
private const val RECORD = 0xFFFF5A36.toInt()

/**
 * The floating dictation pill, drawn to match the desktop overlay: a dark rounded pill with a
 * pulsing red dot, live waveform, elapsed time and cancel/confirm buttons while listening; bouncing
 * dots while processing; a check or warning with a message afterwards. At rest it collapses to a
 * mic button (a wide pill or a compact circle) that the user can park anywhere near the keyboard.
 *
 * Every state grows out of the same anchor point and all transitions are one continuous,
 * time-based morph: size, corner radius and colour interpolate while the old and new contents
 * cross-fade.
 *
 * The view lives in a *canvas* window that is never touchable and is sized for every state the
 * pill can take at its anchor, so turning the mic on or off never moves or resizes it. (Moving a
 * window and redrawing into it are not atomic on Android: the view draws for the new origin a
 * few frames before the system applies the move, and the pill visibly jumps by the difference
 * and snaps back. Growing the window before a morph and shrinking it afterwards did exactly that
 * at both ends of every idle transition.) Touches arrive through a separate, invisible *touch*
 * window that hugs the pill; it is free to follow the pill because nothing is drawn in it.
 * Without a [host] the view is a self-contained preview that handles its own touches.
 */
class OverlayPillView(context: Context) : View(context) {

    /** Owner of the two overlay windows this view drives (all frames in screen coordinates). */
    interface Host {
        /**
         * The window the pill is drawn in. Only grows, and only when the anchor moves or edit mode
         * toggles; never on a state change. Must not be touchable.
         */
        fun applyCanvasFrame(frame: Box)

        /** The window that receives touches and relays them via [onScreenTouch]; hugs the pill. */
        fun applyTouchFrame(frame: Box)
    }

    var host: Host? = null

    /** Embedded in the settings screen: the view's own bounds are the "screen" and the pill is centred. */
    var previewMode = false

    var onMicTap: (() -> Unit)? = null
    var onCancelTap: (() -> Unit)? = null
    var onConfirmTap: (() -> Unit)? = null
    var onEditDone: (() -> Unit)? = null
    var onEditReset: (() -> Unit)? = null

    /** Edit mode: the user dropped the button somewhere new. */
    var onAnchorChanged: ((OverlayAnchor) -> Unit)? = null

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

    private enum class Chip { DONE, RESET }

    private val density = resources.displayMetrics.density
    private fun dp(v: Float): Float = v * density
    private fun sp(v: Float): Float = v * resources.displayMetrics.scaledDensity

    // ---- inputs ---------------------------------------------------------------------------------

    private var state: DictationState = DictationState.Idle
    private var shape = OverlayShape.PILL
    private var anchor = OverlayAnchor.DEFAULT
    private var palette = PillPalette.DEFAULT
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
    private var curBg = palette.background
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
    private var pillBox = Box.EMPTY

    // ---- host windows ---------------------------------------------------------------------------

    /** The canvas window's frame; everything is drawn translated by its origin. */
    private var windowFrame = Box.EMPTY
    private var canvasApplied = false
    private var canvasIsScreen = false
    private var touchFrame = Box.EMPTY
    private var touchApplied = false

    // ---- continuous animation -------------------------------------------------------------------

    private val barTargets = FloatArray(BAR_COUNT + 1) { 0.06f }
    private val barLevels = FloatArray(BAR_COUNT + 1) { 0.06f }
    private var nextBarShiftAt = 0L
    private var latestLevel = 0f
    private var lastElapsedSec = 0
    private var pressed = false
    private var pressScale = 1f

    // ---- edit mode ------------------------------------------------------------------------------

    private var dragging = false
    private var dragPosition: Pair<Float, Float>? = null
    private var grabDx = 0f
    private var grabDy = 0f
    private var pressedChip: Chip? = null
    private var doneBox = Box.EMPTY
    private var resetBox = Box.EMPTY

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

    fun configure(shape: OverlayShape, anchor: OverlayAnchor) {
        val changed = shape != this.shape || anchor != this.anchor
        this.shape = shape
        this.anchor = anchor
        if (changed) retarget()
    }

    /** Theme colours; the body colour morphs to the new value like any other look change. */
    fun setPalette(palette: PillPalette) {
        if (palette == this.palette) return
        this.palette = palette
        retarget()
        invalidate()
    }

    fun setEditing(editing: Boolean) {
        if (this.editing == editing) return
        this.editing = editing
        dragging = false
        dragPosition = null
        pressed = false
        pressedChip = null
        retarget()
        // The look and anchor rarely change here (idle button, same spot), so retarget() may have
        // nothing to morph; the windows still have to switch between the screen and the pill.
        requestFrames()
        invalidate()
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
        OverlayShape.PILL -> Look(Kind.IDLE, dp(64f), dp(36f), palette.background)
        OverlayShape.CIRCLE -> Look(Kind.IDLE, dp(36f), dp(36f), palette.background)
    }

    private fun listeningLook(): Look {
        val maxW = if (screenW > 0f) screenW - 2 * dp(OverlayGeometry.EDGE_MARGIN_DP) else Float.MAX_VALUE
        return Look(Kind.LISTENING, min(dp(232f), maxW), dp(TALL_DP), palette.background)
    }

    private fun lookFor(s: DictationState): Look = when (s) {
        is DictationState.Idle -> idleLook()
        is DictationState.Listening -> listeningLook()
        is DictationState.Processing -> Look(Kind.PROCESSING, textPaint.measureText(s.label) + dp(64f), dp(TALL_DP), palette.background, s.label)
        is DictationState.Success -> Look(Kind.SUCCESS, textPaint.measureText(s.message) + dp(56f), dp(TALL_DP), palette.successBackground, s.message)
        is DictationState.Error -> Look(Kind.ERROR, min(dp(MESSAGE_MAX_W_DP), textPaint.measureText(s.message) + dp(56f)), dp(TALL_DP), palette.errorBackground, s.message)
    }

    /** Screen-space centre of the resting button (the point every state grows out of). */
    private fun anchorPointNow(): Pair<Float, Float> {
        if (previewMode) return (screenW / 2f) to (screenH / 2f)
        dragPosition?.let { return it }
        val idle = idleLook()
        return OverlayGeometry.anchorPoint(anchor, screenW, screenH, keyboardTop, density, idle.w, idle.h)
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
        requestFrames()
        invalidate()
    }

    /**
     * Every box the pill can occupy at this anchor: the resting button, the listening bar and the
     * widest message (plus whatever the outline is actually doing, should a look exceed the cap).
     */
    private fun statesUnion(ax: Float, ay: Float): Box {
        val wide = min(dp(MESSAGE_MAX_W_DP), screenW - 2 * dp(OverlayGeometry.EDGE_MARGIN_DP)).coerceAtLeast(1f)
        return boxFor(idleLook(), ax, ay)
            .union(OverlayGeometry.place(ax, ay, wide, dp(TALL_DP), screenW, screenH, density))
            .union(boxFor(fromLook, fromAx, fromAy))
            .union(boxFor(toLook, toAx, toAy))
    }

    /** Ask the host for the windows this morph needs (or the whole screen while editing). */
    private fun requestFrames() {
        if (previewMode || host == null) {
            windowFrame = Box(0f, 0f, width.toFloat(), height.toFloat())
            return
        }
        if (screenW <= 0f || screenH <= 0f) return
        val screen = Box(0f, 0f, screenW, screenH)
        if (editing) {
            requestCanvas(screen)
            requestTouch(screen)
            return
        }
        requestCanvas(
            statesUnion(fromAx, fromAy).union(statesUnion(toAx, toAy)).inflate(dp(SHADOW_PAD_DP)).intersect(screen)
        )
        requestTouch(
            boxFor(fromLook, fromAx, fromAy).union(boxFor(toLook, toAx, toAy)).inflate(dp(TOUCH_PAD_DP)).intersect(screen)
        )
    }

    /**
     * The canvas only ever grows (an anchor that moves back and forth, e.g. a keyboard whose
     * suggestion strip comes and goes, settles on a window covering both), and is only rebuilt
     * from scratch when edit mode toggles. Shrinking or moving it would change its origin, and an
     * origin change is precisely the jump this design exists to avoid.
     */
    private fun requestCanvas(required: Box) {
        val next = when {
            !canvasApplied || canvasIsScreen != editing -> required
            windowFrame.encloses(required) -> return
            else -> windowFrame.union(required)
        }
        canvasApplied = true
        canvasIsScreen = editing
        windowFrame = next
        host?.applyCanvasFrame(next)
    }

    private fun requestTouch(frame: Box) {
        if (touchApplied && frame.approximately(touchFrame)) return
        touchFrame = frame
        touchApplied = true
        host?.applyTouchFrame(frame)
    }

    /** After a morph settles, pull the touch window back in around the pill. */
    private fun tightenTouchFrame() {
        if (previewMode || host == null || editing || morphStart >= 0L) return
        val screen = Box(0f, 0f, screenW, screenH)
        requestTouch(boxFor(toLook, toAx, toAy).inflate(dp(TOUCH_PAD_DP)).intersect(screen))
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
                post { tightenTouchFrame() }
            }
        }
        val e = easeOutCubic(t)
        curW = lerp(fromLook.w, toLook.w, e)
        curH = lerp(fromLook.h, toLook.h, e)
        curBg = ColorUtils.blendARGB(fromLook.bg, toLook.bg, e)
        curAx = lerp(fromAx, toAx, e)
        curAy = lerp(fromAy, toAy, e)
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

        if (editing) drawEditGuides(canvas, now, drawn)

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
        if (editing) drawEditChrome(canvas, now, drawn)

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
            Kind.SUCCESS -> drawMessage(canvas, box, look, palette.successForeground, true, now)
            Kind.ERROR -> drawMessage(canvas, box, look, palette.errorForeground, false, now)
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
        paint.color = palette.accent
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
        paint.color = RECORD
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
        paint.color = palette.accent
        canvas.drawCircle(confirmCx, cy, btnR - dp(2f), paint)
        // Light accents (Material You tone 80) need a dark tick to stay legible.
        strokePaint.color = if (Oklch.fromArgb(palette.accent).l > 0.7) 0xE6000000.toInt() else Color.WHITE
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

    // ---- edit mode drawing ----------------------------------------------------------------------

    private fun drawEditGuides(canvas: Canvas, now: Long, button: Box) {
        // Where the listening pill will land when the button is tapped from here.
        val listening = listeningLook()
        val ghost = OverlayGeometry.place(curAx, curAy, listening.w, listening.h, screenW, screenH, density)
        scratchRect.set(ghost.left, ghost.top, ghost.right, ghost.bottom)
        scratchPath.rewind()
        scratchPath.addRoundRect(scratchRect, ghost.height / 2f, ghost.height / 2f, Path.Direction.CW)
        dashPaint.color = 0x59FFFFFF
        canvas.drawPath(scratchPath, dashPaint)

        // Snapped to the middle: a thin guide line.
        if (abs(curAx - screenW / 2f) < 0.5f) {
            dashPaint.color = ColorUtils.setAlphaComponent(palette.accent, 0x80)
            canvas.drawLine(screenW / 2f, button.top - dp(48f), screenW / 2f, button.bottom + dp(48f), dashPaint)
        }

        // Pulsing halo hugging the button's outline (a ring for the circle, a capsule for the pill).
        val pulse = sin(2.0 * PI * (now % 1600L) / 1600.0).toFloat()
        val pad = dp(7f) + dp(2.5f) * pulse
        val halo = button.inflate(pad)
        strokePaint.color = ColorUtils.setAlphaComponent(palette.accent, (150 + 60 * pulse).toInt().coerceIn(0, 255))
        strokePaint.strokeWidth = dp(2f)
        scratchRect.set(halo.left, halo.top, halo.right, halo.bottom)
        canvas.drawRoundRect(scratchRect, halo.height / 2f, halo.height / 2f, strokePaint)
    }

    private fun drawEditChrome(canvas: Canvas, now: Long, button: Box) {
        val topInset = statusBarInset()
        val chipH = dp(38f)
        val chipY = max(topInset, dp(24f)) + dp(20f)
        val resetW = smallTextPaint.measureText("Reset") + dp(32f)
        val doneW = smallTextPaint.measureText("Done") + dp(36f)
        val total = resetW + dp(10f) + doneW
        val left = (screenW - total) / 2f
        resetBox = Box(left, chipY, left + resetW, chipY + chipH)
        doneBox = Box(left + resetW + dp(10f), chipY, left + total, chipY + chipH)
        drawChip(canvas, resetBox, "Reset", palette.background, Color.WHITE, pressedChip == Chip.RESET)
        val onAccent = if (Oklch.fromArgb(palette.accent).l > 0.7) 0xE6000000.toInt() else Color.WHITE
        drawChip(canvas, doneBox, "Done", palette.accent, onAccent, pressedChip == Chip.DONE)

        // Hint label near the button.
        val hint = if (dragging) "Release to place" else "Drag to move"
        val hintW = smallTextPaint.measureText(hint) + dp(24f)
        val hintH = dp(28f)
        var hintTop = button.top - dp(16f) - hintH
        if (hintTop < chipY + chipH + dp(8f)) hintTop = button.bottom + dp(16f)
        val hintLeft = OverlayGeometry.clampCenter(button.centerX, hintW, screenW, dp(8f)) - hintW / 2f
        drawChip(canvas, Box(hintLeft, hintTop, hintLeft + hintW, hintTop + hintH), hint, 0xE6202024.toInt(), 0xE6FFFFFF.toInt(), false)
    }

    private fun drawChip(canvas: Canvas, box: Box, label: String, bg: Int, fg: Int, isPressed: Boolean) {
        val drawn = if (isPressed) Box.centered(box.centerX, box.centerY, box.width * 0.96f, box.height * 0.96f) else box
        val r = drawn.height / 2f
        paint.color = bg
        pillPaint.color = bg
        pillPaint.setShadowLayer(dp(4f), 0f, dp(1.5f), 0x40000000)
        scratchRect.set(drawn.left, drawn.top, drawn.right, drawn.bottom)
        canvas.drawRoundRect(scratchRect, r, r, pillPaint)
        pillPaint.clearShadowLayer()
        strokePaint.color = 0x1FFFFFFF
        strokePaint.strokeWidth = dp(1f)
        canvas.drawRoundRect(scratchRect, r, r, strokePaint)
        smallTextPaint.color = fg
        canvas.drawText(label, drawn.centerX - smallTextPaint.measureText(label) / 2f, drawn.centerY + smallTextPaint.textSize / 2.8f, smallTextPaint)
        smallTextPaint.color = Color.WHITE
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
        if (morphStart >= 0L || editing || dragging) return true
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

    /** Preview / hostless mode: this view is its own touch surface. */
    override fun onTouchEvent(event: MotionEvent): Boolean =
        onScreenTouch(event, event.x + windowFrame.left, event.y + windowFrame.top)

    /** A touch relayed by the host's touch window, with the pointer's position in screen coordinates. */
    fun onScreenTouch(event: MotionEvent, x: Float, y: Float): Boolean {
        if (editing) return onEditTouch(event, x, y)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (!pillBox.inflate(dp(6f)).contains(x, y)) return false
                pressed = true
                invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (pressed && !pillBox.inflate(dp(28f)).contains(x, y)) {
                    pressed = false
                    invalidate()
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                val fire = pressed
                pressed = false
                invalidate()
                if (fire) tap(x, y)
                performClick()
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
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
                when {
                    pillBox.inflate(dp(16f)).contains(x, y) -> {
                        dragging = true
                        pressed = true
                        grabDx = x - curAx
                        grabDy = y - curAy
                    }
                    doneBox.contains(x, y) -> pressedChip = Chip.DONE
                    resetBox.contains(x, y) -> pressedChip = Chip.RESET
                }
                invalidate()
            }
            MotionEvent.ACTION_MOVE -> if (dragging) {
                setDragPosition(x - grabDx, y - grabDy)
                invalidate()
            }
            MotionEvent.ACTION_UP -> {
                if (dragging) {
                    dragging = false
                    pressed = false
                    commitDrag()
                } else if (pressedChip == Chip.DONE && doneBox.contains(x, y)) {
                    onEditDone?.invoke()
                } else if (pressedChip == Chip.RESET && resetBox.contains(x, y)) {
                    onEditReset?.invoke()
                }
                pressedChip = null
                invalidate()
                performClick()
            }
            MotionEvent.ACTION_CANCEL -> {
                if (dragging) commitDrag()
                dragging = false
                pressed = false
                pressedChip = null
                invalidate()
            }
        }
        return true
    }

    private fun setDragPosition(cx: Float, cy: Float) {
        val idle = idleLook()
        val margin = dp(OverlayGeometry.EDGE_MARGIN_DP)
        val nx = OverlayGeometry.clampCenter(OverlayGeometry.snapX(cx, screenW, density), idle.w, screenW, margin)
        val ny = OverlayGeometry.clampCenter(cy, idle.h, screenH, margin)
        dragPosition = nx to ny
        fromAx = nx
        toAx = nx
        fromAy = ny
        toAy = ny
        curAx = nx
        curAy = ny
        morphStart = -1L
    }

    private fun commitDrag() {
        val next = OverlayGeometry.anchorFor(curAx, curAy, screenW, screenH, keyboardTop, density).rounded()
        dragPosition = null
        anchor = next
        onAnchorChanged?.invoke(next)
        retarget(animate = false)
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }
}
