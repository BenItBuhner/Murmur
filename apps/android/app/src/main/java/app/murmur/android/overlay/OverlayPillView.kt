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
import app.murmur.android.overlay.OverlayMotion.easeOutCubic
import app.murmur.android.overlay.OverlayMotion.lerp
import app.murmur.android.overlay.OverlayMotion.smoothstep
import app.murmur.android.settings.OverlayShape
import app.murmur.android.ui.theme.Oklch
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

private const val BAR_COUNT = 16
private const val BAR_STEP_MS = 64L
private const val SHADOW_PAD_DP = 12f

/** Vertical travel of a label while it hands over to the next one. */
private const val TEXT_SWAP_SHIFT_DP = 6f

/** The pulsing "recording" dot: a fixed red-orange, whatever the theme, because that is what it means. */
private const val RECORD = 0xFFFF5A36.toInt()

/**
 * The floating dictation pill, drawn to match the desktop overlay: a dark rounded pill with a
 * pulsing red dot, live waveform, elapsed time and cancel/confirm buttons while listening; bouncing
 * dots while processing; a check or warning with a message afterwards. At rest it collapses to a
 * mic button (a wide pill or a compact circle) that the user can park anywhere near the keyboard.
 *
 * Every state grows out of the same anchor point. The outline (size, corner radius, colour,
 * position) is one continuous time-based morph; the contents are a [LayerStack] drawn on top and
 * clipped by the outline. Contents are laid out in the box their state rests in, not in the
 * mid-morph outline, so the outline *reveals* incoming controls as it grows and closes over
 * outgoing ones as it shrinks instead of dragging them along. Layers cross-fade with
 * complementary curves and each keeps its own clock, so the pill never shows an empty outline and
 * a state change that lands mid-fade cannot drop whatever is currently visible (see
 * [OverlayMotion]).
 *
 * The window that hosts the view is only ever resized *before* a morph starts (to the union of
 * both shapes) and tightened *after* it settles, so the pixels of the pill never jump when the
 * window changes. Without a [host] the view is a self-contained preview.
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

    /** Edit mode: the user dropped the button somewhere new. */
    var onAnchorChanged: ((OverlayAnchor) -> Unit)? = null

    private enum class Kind { IDLE, LISTENING, PROCESSING, SUCCESS, ERROR }

    /** The resting appearance of one state: its size, colour and what is drawn inside. */
    private data class Look(
        val kind: Kind,
        val w: Float,
        val h: Float,
        val bg: Int,
        val text: String = ""
    ) {
        /** Same drawn contents (size and colour may differ, e.g. after a screen change). */
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

    // ---- outline morph --------------------------------------------------------------------------

    /** Where the outline is heading. */
    private var toLook: Look = idleLook()
    private var toAx = 0f
    private var toAy = 0f

    /** Where the running morph started: a snapshot of wherever the outline was at that moment. */
    private var fromW = 0f
    private var fromH = 0f
    private var fromBg = palette.background
    private var fromAx = 0f
    private var fromAy = 0f

    /** The outline as drawn this frame. */
    private var curW = 0f
    private var curH = 0f
    private var curBg = palette.background
    private var curAx = 0f
    private var curAy = 0f

    /** -1: at rest, 0: morph requested (clock starts on the first frame), otherwise the start time. */
    private var morphStart = -1L
    private var morphDuration = OverlayMotion.MORPH_MS
    private var hasDrawn = false
    private var lastFrameAt = 0L
    private var windowFrame = Box.EMPTY
    private var frameApplied = false
    private var pillBox = Box.EMPTY

    // ---- contents -------------------------------------------------------------------------------

    private val layers = LayerStack<Look>()

    // ---- continuous animation -------------------------------------------------------------------

    private val barTargets = FloatArray(BAR_COUNT + 1) { 0.06f }
    private val barLevels = FloatArray(BAR_COUNT + 1) { 0.06f }
    private var nextBarShiftAt = 0L
    private var barsAdvancedAt = -1L
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
        return Look(Kind.LISTENING, min(dp(232f), maxW), dp(46f), palette.background)
    }

    private fun lookFor(s: DictationState): Look = when (s) {
        is DictationState.Idle -> idleLook()
        is DictationState.Listening -> listeningLook()
        is DictationState.Processing -> Look(Kind.PROCESSING, textPaint.measureText(s.label) + dp(64f), dp(46f), palette.background, s.label)
        is DictationState.Success -> Look(Kind.SUCCESS, textPaint.measureText(s.message) + dp(56f), dp(46f), palette.successBackground, s.message)
        is DictationState.Error -> Look(Kind.ERROR, min(dp(300f), textPaint.measureText(s.message) + dp(56f)), dp(46f), palette.errorBackground, s.message)
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

    /** The box the current state rests in once the outline has settled. */
    private fun targetBox(): Box = boxFor(toLook, toAx, toAy)

    /** Re-evaluate the target look and anchor; start a morph from wherever the outline currently is. */
    private fun retarget(animate: Boolean = true) {
        if (screenW <= 0f || screenH <= 0f) return
        val newLook = if (editing) idleLook() else lookFor(state)
        val (ax, ay) = anchorPointNow()
        val lookChanged = newLook != toLook
        val anchorChanged = abs(ax - toAx) > 0.5f || abs(ay - toAy) > 0.5f
        if (!lookChanged && !anchorChanged) return
        val now = AnimationUtils.currentAnimationTimeMillis()
        val contentChanged = !newLook.sameContent(toLook)
        if (!hasDrawn || !animate || dragging) {
            toLook = newLook
            toAx = ax
            toAy = ay
            fromW = newLook.w
            fromH = newLook.h
            fromBg = newLook.bg
            fromAx = ax
            fromAy = ay
            curW = newLook.w
            curH = newLook.h
            curBg = newLook.bg
            curAx = ax
            curAy = ay
            morphStart = -1L
            layers.snap(newLook, targetBox(), now)
        } else {
            fromW = curW
            fromH = curH
            fromBg = curBg
            fromAx = curAx
            fromAy = curAy
            toLook = newLook
            toAx = ax
            toAy = ay
            morphStart = 0L
            morphDuration = if (lookChanged) OverlayMotion.MORPH_MS else OverlayMotion.MOVE_MS
            val target = targetBox()
            val current = layers.current
            if (contentChanged || current == null) {
                // New contents are laid out where they will rest; the outline reveals them.
                layers.push(newLook, target, now)
            } else {
                // Same contents: they ride along with the outline from wherever they are now.
                current.content = newLook
                current.fromBox = current.box
            }
        }
        requestFrame()
        invalidate()
    }

    /** Window frame covering both ends of the morph (or the whole screen while editing). */
    private fun requestFrame() {
        if (previewMode || host == null) {
            windowFrame = Box(0f, 0f, width.toFloat(), height.toFloat())
            return
        }
        val screen = Box(0f, 0f, screenW, screenH)
        val frame = if (editing) screen else {
            OverlayGeometry.place(fromAx, fromAy, fromW, fromH, screenW, screenH, density)
                .union(targetBox())
                .inflate(dp(SHADOW_PAD_DP))
                .intersect(screen)
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
        if (previewMode || host == null || editing || morphStart >= 0L) return
        val screen = Box(0f, 0f, screenW, screenH)
        applyFrame(targetBox().inflate(dp(SHADOW_PAD_DP)).intersect(screen))
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
                post { tightenFrame() }
            }
        }
        val e = easeOutCubic(t)
        curW = lerp(fromW, toLook.w, e)
        curH = lerp(fromH, toLook.h, e)
        curBg = ColorUtils.blendARGB(fromBg, toLook.bg, e)
        curAx = lerp(fromAx, toAx, e)
        curAy = lerp(fromAy, toAy, e)

        if (layers.isEmpty) layers.snap(toLook, targetBox(), now)
        if (layers.layers.none { it.content.kind == Kind.LISTENING }) resetBars()

        pressScale = OverlayMotion.approach(pressScale, pressTarget(), dt, 55f)

        // Everything below is in screen coordinates.
        canvas.save()
        canvas.translate(-windowFrame.left, -windowFrame.top)

        val outline = OverlayGeometry.place(curAx, curAy, curW, curH, screenW, screenH, density)
        pillBox = outline
        val pressing = abs(pressScale - 1f) > 0.001f
        val drawn = if (pressing) outline.scaled(pressScale, outline.centerX, outline.centerY) else outline

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

        drawContents(canvas, drawn, e, pressing, now, dt)

        if (editing) drawEditChrome(canvas, now, drawn)

        canvas.restore()
        hasDrawn = true
        if (isAnimating(now)) postInvalidateOnAnimation()
    }

    /**
     * The layer stack, oldest first, each clipped by the outline. The current layer's box eases
     * from where its slide began to the resting box of its state (they coincide for new contents,
     * which are revealed in place); leaving layers stay where they were frozen and fade.
     */
    private fun drawContents(canvas: Canvas, outline: Box, e: Float, pressing: Boolean, now: Long, dt: Long) {
        layers.current?.let { it.box = lerp(it.fromBox, targetBox(), e) }

        // The bouncing dots are shared by every processing label: drawn once, with the layers'
        // alphas summed, so a label change ("Transcribing…" -> "Formatting…") cross-fades only
        // the text and the dots never dip.
        var dotsAlpha = 0f
        var dotsLayer: LayerStack.Layer<Look>? = null
        for (layer in layers.layers) {
            if (layer.content.kind != Kind.PROCESSING) continue
            dotsAlpha += layers.alphaOf(layer, now)
            dotsLayer = layer
        }

        canvas.save()
        canvas.clipPath(clipPath)
        for (layer in layers.layers) {
            val box = if (pressing) layer.box.scaled(pressScale, outline.centerX, outline.centerY) else layer.box
            if (layer === dotsLayer) drawProcessingDots(canvas, box, now, min(1f, dotsAlpha))
            val alpha = layers.alphaOf(layer, now)
            if (alpha <= OverlayMotion.GONE_ALPHA) continue
            drawLayer(canvas, box, layer, alpha, now, dt)
        }
        canvas.restore()
        layers.prune(now)
    }

    private fun drawLayer(canvas: Canvas, box: Box, layer: LayerStack.Layer<Look>, alpha: Float, now: Long, dt: Long) {
        val full = alpha >= 0.999f
        if (!full) {
            canvas.saveLayerAlpha(box.left, box.top, box.right, box.bottom, (alpha * 255f).toInt().coerceIn(0, 255))
        }
        val look = layer.content
        // Labels swap like a ticker: the outgoing one drifts up as it fades, the incoming one
        // arrives from just below. Two labels dissolving in exactly the same place read as a
        // smear; a few dp of separation makes it a clean hand-over. Icon-only states stay put so
        // the outline can reveal them in place.
        if (!full && (look.kind == Kind.PROCESSING || look.kind == Kind.SUCCESS || look.kind == Kind.ERROR)) {
            val shift = dp(TEXT_SWAP_SHIFT_DP) * (1f - alpha)
            canvas.translate(0f, if (layer.leaving) -shift else shift)
        }
        when (look.kind) {
            Kind.IDLE -> drawIdle(canvas, box)
            Kind.LISTENING -> drawListening(canvas, box, now, dt)
            Kind.PROCESSING -> drawProcessingLabel(canvas, box, look.text)
            Kind.SUCCESS -> drawMessage(canvas, box, look, palette.successForeground, true, now - layer.shownSince)
            Kind.ERROR -> drawMessage(canvas, box, look, palette.errorForeground, false, 0L)
        }
        if (!full) canvas.restore()
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

        // Conveyor-belt waveform: bars slide left continuously between level samples. Advanced once
        // per frame even if two listening layers overlap for a moment.
        if (barsAdvancedAt != now) {
            advanceBars(now, dt)
            barsAdvancedAt = now
        }
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

    /** Left edge of a processing label: three dots, then the text. */
    private fun processingTextX(box: Box): Float = box.left + dp(20f) + 3 * dp(10f) + dp(4f)

    private fun drawProcessingDots(canvas: Canvas, box: Box, now: Long, alpha: Float) {
        val cy = box.centerY
        var x = box.left + dp(20f)
        paint.color = Color.WHITE
        val phase = 2.0 * PI * (now % 1100L) / 1100.0
        for (i in 0 until 3) {
            val bounce = max(0.0, sin(phase - i * 0.9)).toFloat() * dp(3.5f)
            paint.alpha = ((140 + 115 * (bounce / dp(3.5f))) * alpha).toInt().coerceIn(0, 255)
            canvas.drawCircle(x, cy - bounce + dp(1.5f), dp(2.6f), paint)
            x += dp(10f)
        }
        paint.alpha = 255
    }

    private fun drawProcessingLabel(canvas: Canvas, box: Box, label: String) {
        textPaint.color = 0xD9FFFFFF.toInt()
        canvas.drawText(label, processingTextX(box), box.centerY + textPaint.textSize / 2.8f, textPaint)
        textPaint.color = Color.WHITE
    }

    private fun drawMessage(canvas: Canvas, box: Box, look: Look, color: Int, check: Boolean, shownForMs: Long) {
        val cy = box.centerY
        val iconCx = box.left + dp(22f)
        strokePaint.color = color
        strokePaint.strokeWidth = dp(2.4f)
        if (check) {
            // The tick draws itself in once the pill has (mostly) taken its new shape.
            val p = smoothstep(0f, 1f, ((shownForMs - 120L).toFloat() / 260f).coerceIn(0f, 1f))
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
        // Fit the text to the pill's resting width: the layer is laid out in that box and the
        // outline clips it while morphing, so nothing re-ellipsizes frame by frame.
        var msg = look.text
        val maxWidth = look.w - dp(48f)
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
        if (!layers.isSettled(now)) return true
        val current = layers.current ?: return false
        val kind = current.content.kind
        if (kind == Kind.LISTENING || kind == Kind.PROCESSING) return true
        return kind == Kind.SUCCESS && now - current.shownSince < 500L
    }

    // ---- touch ----------------------------------------------------------------------------------

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val x = event.x + windowFrame.left
        val y = event.y + windowFrame.top
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
        // Settled morph: the current layer's box tracks the target box directly.
        layers.current?.let { it.fromBox = targetBox() }
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
