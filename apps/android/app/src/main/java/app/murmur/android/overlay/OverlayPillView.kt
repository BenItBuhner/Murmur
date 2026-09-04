package app.murmur.android.overlay

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import app.murmur.android.dictation.DictationState
import kotlin.math.max
import kotlin.math.min

private const val BAR_COUNT = 16

/**
 * The floating dictation pill, drawn to match the desktop overlay: a dark rounded pill with
 * a pulsing red dot, live waveform, elapsed time, and cancel/confirm buttons while listening.
 * Collapsed to a compact mic button when idle (shown whenever the keyboard is open).
 */
class OverlayPillView(context: Context) : View(context) {

    var onMicTap: (() -> Unit)? = null
    var onCancelTap: (() -> Unit)? = null
    var onConfirmTap: (() -> Unit)? = null

    private var state: DictationState = DictationState.Idle
    private val levels = FloatArray(BAR_COUNT) { 0.06f }
    private var animPhase = 0f

    private val pillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = sp(13f)
        typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
    }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }

    private val cancelRect = RectF()
    private val confirmRect = RectF()

    fun render(next: DictationState) {
        val prevClass = state::class
        state = next
        if (next is DictationState.Listening) {
            System.arraycopy(levels, 1, levels, 0, BAR_COUNT - 1)
            levels[BAR_COUNT - 1] = max(0.08f, min(1f, next.level + (Math.random().toFloat() - 0.5f) * 0.08f))
        } else if (next is DictationState.Idle) {
            levels.fill(0.06f)
        }
        if (prevClass != next::class) requestLayout()
        invalidate()
    }

    private fun dp(v: Float): Float = v * resources.displayMetrics.density
    private fun sp(v: Float): Float = v * resources.displayMetrics.scaledDensity

    private fun pillWidth(): Float = when (val s = state) {
        is DictationState.Idle -> dp(64f)
        is DictationState.Listening -> dp(232f)
        is DictationState.Processing -> textPaint.measureText(s.label) + dp(64f)
        is DictationState.Success -> textPaint.measureText(s.message) + dp(56f)
        is DictationState.Error -> min(dp(300f), textPaint.measureText(s.message) + dp(56f))
    }

    private fun pillHeight(): Float = if (state is DictationState.Idle) dp(36f) else dp(46f)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension((pillWidth() + dp(8f)).toInt(), (pillHeight() + dp(8f)).toInt())
    }

    override fun onDraw(canvas: Canvas) {
        val w = pillWidth()
        val h = pillHeight()
        val left = (width - w) / 2f
        val top = (height - h) / 2f
        val rect = RectF(left, top, left + w, top + h)
        val radius = h / 2f

        pillPaint.color = when (state) {
            is DictationState.Error -> 0xF23A1512.toInt()
            is DictationState.Success -> 0xF20F2A1C.toInt()
            else -> 0xF2141414.toInt()
        }
        pillPaint.setShadowLayer(dp(6f), 0f, dp(2f), 0x59000000)
        canvas.drawRoundRect(rect, radius, radius, pillPaint)
        pillPaint.clearShadowLayer()

        when (val s = state) {
            is DictationState.Idle -> drawIdle(canvas, rect)
            is DictationState.Listening -> drawListening(canvas, rect, s)
            is DictationState.Processing -> drawProcessing(canvas, rect, s.label)
            is DictationState.Success -> drawMessage(canvas, rect, s.message, 0xFF7EE2A8.toInt(), check = true)
            is DictationState.Error -> drawMessage(canvas, rect, s.message, 0xFFFF8A70.toInt(), check = false)
        }

        animPhase += 0.18f
        if (state is DictationState.Processing) {
            postInvalidateDelayed(66)
        }
    }

    private fun drawIdle(canvas: Canvas, rect: RectF) {
        val cx = rect.centerX()
        val cy = rect.centerY()
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = dp(1.8f)
        val mw = dp(4.4f)
        val mh = dp(7.5f)
        paint.color = 0xFFFF5A36.toInt()
        canvas.drawRoundRect(cx - mw / 2, cy - mh + dp(1f), cx + mw / 2, cy + dp(2.4f), mw / 2, mw / 2, paint)
        canvas.drawArc(cx - dp(7f), cy - dp(4.5f), cx + dp(7f), cy + dp(6.5f), 15f, 150f, false, strokePaint)
        canvas.drawLine(cx, cy + dp(6.5f), cx, cy + dp(9f), strokePaint)
        cancelRect.setEmpty()
        confirmRect.setEmpty()
    }

    private fun drawListening(canvas: Canvas, rect: RectF, s: DictationState.Listening) {
        val cy = rect.centerY()
        val btnR = dp(14f)
        val cancelCx = rect.left + dp(24f)
        cancelRect.set(cancelCx - btnR, cy - btnR, cancelCx + btnR, cy + btnR)
        paint.color = 0x1FFFFFFF
        canvas.drawCircle(cancelCx, cy, btnR - dp(2f), paint)
        strokePaint.color = 0xFFCCCCCC.toInt()
        strokePaint.strokeWidth = dp(2f)
        val xr = dp(4.5f)
        canvas.drawLine(cancelCx - xr, cy - xr, cancelCx + xr, cy + xr, strokePaint)
        canvas.drawLine(cancelCx - xr, cy + xr, cancelCx + xr, cy - xr, strokePaint)
        val dotCx = rect.left + dp(52f)
        val pulse = 1f + 0.18f * kotlin.math.sin(animPhase * 2).toFloat()
        paint.color = 0xFFFF5A36.toInt()
        canvas.drawCircle(dotCx, cy, dp(3.6f) * pulse, paint)
        val barsLeft = dotCx + dp(12f)
        val barW = dp(2.6f)
        val gap = dp(2.2f)
        paint.color = Color.WHITE
        for (i in 0 until BAR_COUNT) {
            val v = levels[i]
            val bh = max(dp(3f), v * dp(20f))
            paint.alpha = (140 + v * 115).toInt().coerceIn(0, 255)
            val x = barsLeft + i * (barW + gap)
            canvas.drawRoundRect(x, cy - bh / 2, x + barW, cy + bh / 2, barW / 2, barW / 2, paint)
        }
        paint.alpha = 255
        val mins = s.elapsedSec / 60
        val secs = s.elapsedSec % 60
        textPaint.color = 0xB3FFFFFF.toInt()
        canvas.drawText("%d:%02d".format(mins, secs), barsLeft + BAR_COUNT * (barW + gap) + dp(6f), cy + textPaint.textSize / 2.8f, textPaint)
        textPaint.color = Color.WHITE
        val confirmCx = rect.right - dp(24f)
        confirmRect.set(confirmCx - btnR, cy - btnR, confirmCx + btnR, cy + btnR)
        paint.color = 0xFFFF5A36.toInt()
        canvas.drawCircle(confirmCx, cy, btnR - dp(2f), paint)
        strokePaint.color = Color.WHITE
        strokePaint.strokeWidth = dp(2.2f)
        canvas.drawLine(confirmCx - dp(4.6f), cy + dp(0.5f), confirmCx - dp(1f), cy + dp(4f), strokePaint)
        canvas.drawLine(confirmCx - dp(1f), cy + dp(4f), confirmCx + dp(5f), cy - dp(3.5f), strokePaint)
    }

    private fun drawProcessing(canvas: Canvas, rect: RectF, label: String) {
        val cy = rect.centerY()
        var x = rect.left + dp(20f)
        paint.color = Color.WHITE
        for (i in 0 until 3) {
            val phase = animPhase * 2 - i * 0.9f
            val bounce = max(0f, kotlin.math.sin(phase).toFloat()) * dp(3.5f)
            canvas.drawCircle(x, cy - bounce + dp(1.5f), dp(2.6f), paint)
            x += dp(10f)
        }
        textPaint.color = 0xD9FFFFFF.toInt()
        canvas.drawText(label, x + dp(4f), cy + textPaint.textSize / 2.8f, textPaint)
        textPaint.color = Color.WHITE
        cancelRect.setEmpty()
        confirmRect.setEmpty()
    }

    private fun drawMessage(canvas: Canvas, rect: RectF, message: String, color: Int, check: Boolean) {
        val cy = rect.centerY()
        val iconCx = rect.left + dp(22f)
        strokePaint.color = color
        strokePaint.strokeWidth = dp(2.4f)
        if (check) {
            canvas.drawLine(iconCx - dp(5f), cy, iconCx - dp(1f), cy + dp(4f), strokePaint)
            canvas.drawLine(iconCx - dp(1f), cy + dp(4f), iconCx + dp(6f), cy - dp(4f), strokePaint)
        } else {
            strokePaint.strokeWidth = dp(2f)
            canvas.drawCircle(iconCx, cy, dp(7f), strokePaint)
            canvas.drawLine(iconCx, cy - dp(3.5f), iconCx, cy + dp(0.8f), strokePaint)
            paint.color = color
            canvas.drawCircle(iconCx, cy + dp(3.6f), dp(1f), paint)
        }
        var msg = message
        val maxWidth = rect.width() - dp(48f)
        if (textPaint.measureText(msg) > maxWidth) {
            while (msg.length > 4 && textPaint.measureText("$msg…") > maxWidth) msg = msg.dropLast(1)
            msg = "$msg…"
        }
        canvas.drawText(msg, rect.left + dp(38f), cy + textPaint.textSize / 2.8f, textPaint)
        cancelRect.setEmpty()
        confirmRect.setEmpty()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_UP) {
            val x = event.x
            val y = event.y
            when {
                state is DictationState.Listening && cancelRect.contains(x, y) -> onCancelTap?.invoke()
                state is DictationState.Listening && confirmRect.contains(x, y) -> onConfirmTap?.invoke()
                state is DictationState.Listening -> onConfirmTap?.invoke()
                state is DictationState.Idle -> onMicTap?.invoke()
            }
            performClick()
            return true
        }
        return event.actionMasked == MotionEvent.ACTION_DOWN
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }
}
