package app.murmur.android.overlay

import android.graphics.Canvas
import android.graphics.Paint
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Ember Dots, the Ephemeris listening pill: a fine dot grid fills the capsule edge to edge and a warm
 * wave (deep ember, coral, honey, ivory) rides the live mic level. A straight port of the desktop
 * renderer (Ephemeris apps/desktop/src/renderer/src/overlay/ember-dots.ts): same wave, colour ramp,
 * dot sizes, alphas and follower timings, in dp instead of CSS px. The grid is laid out for whatever
 * capsule it is given, at the desktop's 3.9 dp pitch.
 */
object EmberDots {
    private fun clamp(x: Double, a: Double = 0.0, b: Double = 1.0) = min(b, max(a, x))
    private fun lerp(a: Double, b: Double, k: Double) = a + (b - a) * k
    private fun sstep(a: Double, b: Double, x: Double): Double {
        val k = clamp((x - a) / (b - a)); return k * k * (3 - 2 * k)
    }

    class Lab(val l: Double, val a: Double, val b: Double)
    private fun oklab(l: Double, c: Double, h: Double): Lab { val r = h * PI / 180; return Lab(l, c * cos(r), c * sin(r)) }
    private fun mix(p: Lab, q: Lab, k: Double) = Lab(lerp(p.l, q.l, k), lerp(p.a, q.a, k), lerp(p.b, q.b, k))

    /** OKLab to packed sRGB (alpha 0). */
    fun lab2rgb(c: Lab): Int {
        val l = (c.l + 0.3963377774 * c.a + 0.2158037573 * c.b).pow(3)
        val m = (c.l - 0.1055613458 * c.a - 0.0638541728 * c.b).pow(3)
        val s = (c.l - 0.0894841775 * c.a - 1.291485548 * c.b).pow(3)
        val lin = doubleArrayOf(
            4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
        )
        val o = lin.map { v0 ->
            val v = clamp(v0)
            (255 * (if (v <= 0.0031308) 12.92 * v else 1.055 * v.pow(1 / 2.4) - 0.055)).roundToInt()
        }
        return (o[0] shl 16) or (o[1] shl 8) or o[2]
    }

    private val IVORY = oklab(0.97, 0.014, 85.0)
    private val HONEY = oklab(0.86, 0.11, 68.0)
    private val CORAL = oklab(0.74, 0.17, 42.0)
    private val EMBER = oklab(0.6, 0.19, 30.0)
    private val DEEP = oklab(0.36, 0.11, 30.0)

    const val PITCH = 3.9f
    private const val INSET = 2f
    private const val DOT0 = 1.4
    private const val DOT1 = 2.3
    private const val RY_PER_PX = 2.5 / 19.5

    fun dotRamp(k: Double): Lab = when {
        k < 0.12 -> mix(DEEP, EMBER, k / 0.12)
        k < 0.28 -> mix(EMBER, CORAL, (k - 0.12) / 0.16)
        k < 0.52 -> mix(CORAL, HONEY, (k - 0.28) / 0.24)
        else -> mix(HONEY, IVORY, clamp((k - 0.52) / 0.33))
    }

    /** Intensity and colour of the field at column position [u] (0..1), field row [ry]. */
    fun field(u: Double, ry: Double, e: Double, th: Double): Pair<Double, Lab> {
        val taper = 0.3 + 0.7 * sin(PI * clamp(u)).pow(1.1)
        val y0 = 0.95 * e * sin(2 * PI * 0.8 * u - th) + 0.4 * e * sin(2 * PI * 2.1 * u + 1.7 * th)
        val w = 0.5 + 0.95 * e
        val turb = 0.78 + 0.22 * sin(9.5 * u + 2.6 * ry - 2.2 * th)
        val base = exp(-((ry - y0) * (ry - y0)) / (2 * w * w))
        val i = clamp(1.25 * (base * turb * taper).pow(1.4)) * (0.28 + 0.72 * sstep(0.0, 0.4, e))
        return i to dotRamp(clamp(i * (0.5 + 0.7 * e)))
    }

    /** A grid cell inside the capsule, in dp from its centre. */
    class Cell(val x: Float, val y: Float, val u: Double, val ry: Double)

    /** The cells of a [w] x [h] dp capsule (pill-shaped: radius h / 2). */
    fun cells(w: Float, h: Float): List<Cell> {
        val hw = w / 2f
        val hh = h / 2f
        val cols = (w / PITCH).toInt() or 1
        val rows = (h / PITCH).toInt() or 1
        val out = ArrayList<Cell>()
        for (ci in 0 until cols) {
            val x = (ci - (cols - 1) / 2f) * PITCH
            for (r in 0 until rows) {
                val y = (r - (rows - 1) / 2f) * PITCH
                val qx = max(abs(x) - ((hw - INSET) - (hh - INSET)), 0f)
                if (hypot(qx, y) - (hh - INSET) > 0f) continue
                out += Cell(x, y, ((x + hw) / (2 * hw)).toDouble(), y * RY_PER_PX)
            }
        }
        return out
    }

    /**
     * The live input: a 70 ms attack, 220 ms release follower on the mic level, gamma 0.62; the wave
     * drifts at 0.45 Hz and speech pushes it forward. With `live` false the level eases to rest.
     */
    class Engine(private val drift: Boolean = true) {
        private var y = 0.0
        private var acc = 0.0
        private var gate = 1.0
        private var last = -1.0
        private var start = -1.0
        var e = 0.0; private set
        var theta = 0.0; private set
        var t = 0.0; private set

        fun reset() { y = 0.0; acc = 0.0; gate = 1.0; last = -1.0; start = -1.0; e = 0.0; theta = 0.0; t = 0.0 }

        fun step(nowSec: Double, level: Double, live: Boolean = true) {
            if (start < 0 || last < 0) { start = nowSec; last = nowSec }
            val dt = clamp(nowSec - last, 0.0, 0.1)
            last = nowSec
            t = nowSec - start
            val x = if (level.isFinite()) clamp(level) else 0.0
            val tau = if (x > y) 0.07 else 0.22
            y += (x - y) * (1 - exp(-dt / tau))
            gate = if (live) 1.0 else max(0.0, gate - dt / 0.24)
            e = max(0.0, y).pow(0.62) * sstep(0.0, 1.0, gate)
            acc += e * dt
            theta = 2 * PI * ((if (drift) 0.45 * t else 0.0) + 0.85 * acc)
        }
    }

    /**
     * Draws one frame centred on ([cx], [cy]); [density] converts dp to px. The caller clips to the
     * capsule. [dim] scales every dot's alpha (the pill's fade).
     */
    fun draw(canvas: Canvas, paint: Paint, cells: List<Cell>, engine: Engine, cx: Float, cy: Float, density: Float, dim: Float = 1f) {
        val wakeT = engine.t - 0.12
        for (c in cells) {
            val wake = sstep(0.0, 0.1, wakeT - abs(c.u - 0.5) * 0.16)
            if (wake <= 0) continue
            val (i0, col) = field(c.u, c.ry, engine.e, engine.theta)
            val i = clamp(i0) * wake
            val d = lerp(DOT0, DOT1, i.pow(0.8))
            val a = (0.13 * wake + 0.87 * i.pow(1.25)) * dim
            paint.color = (((a * 255).roundToInt().coerceIn(0, 255)) shl 24) or lab2rgb(col)
            canvas.drawCircle(cx + c.x * density, cy + c.y * density, (d / 2 * density).toFloat(), paint)
        }
    }
}
