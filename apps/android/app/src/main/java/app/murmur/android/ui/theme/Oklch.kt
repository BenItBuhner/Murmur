package app.murmur.android.ui.theme

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cbrt
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sign
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A colour in OKLCH: perceptual lightness [l] (0..1), chroma [c] (0 = grey) and hue [h] in degrees.
 *
 * This is the same colour maths the desktop app uses (apps/desktop/src/shared/theme.ts), so a seed
 * colour produces the same palette on both platforms. Pure Kotlin on purpose: no Android classes,
 * so it runs in plain unit tests.
 */
data class Oklch(val l: Double, val c: Double, val h: Double) {

    /** sRGB ARGB (opaque). Out-of-gamut colours keep lightness and hue and lose chroma until they fit. */
    fun toArgb(): Int {
        val lightness = l.coerceIn(0.0, 1.0)
        val rad = h * PI / 180.0
        fun linear(chroma: Double): DoubleArray = oklabToLinearRgb(lightness, chroma * cos(rad), chroma * sin(rad))
        var rgb = linear(c)
        if (!inGamut(rgb)) {
            var lo = 0.0
            var hi = c
            repeat(24) {
                val mid = (lo + hi) / 2
                if (inGamut(linear(mid))) lo = mid else hi = mid
            }
            rgb = linear(lo)
        }
        return argb(linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2]))
    }

    companion object {
        fun fromArgb(argb: Int): Oklch {
            val r = ((argb shr 16) and 0xFF) / 255.0
            val g = ((argb shr 8) and 0xFF) / 255.0
            val b = (argb and 0xFF) / 255.0
            val lab = rgbToOklab(r, g, b)
            val c = sqrt(lab[1] * lab[1] + lab[2] * lab[2])
            if (c < 1e-4) return Oklch(lab[0], 0.0, 0.0)
            var h = atan2(lab[2], lab[1]) * 180.0 / PI
            if (h < 0) h += 360.0
            return Oklch(lab[0], c, h)
        }

        private fun srgbToLinear(c: Double): Double =
            if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)

        private fun linearToSrgb(c: Double): Double =
            if (c <= 0.0031308) 12.92 * c else 1.055 * c.pow(1 / 2.4) - 0.055

        private fun rgbToOklab(r: Double, g: Double, b: Double): DoubleArray {
            val lr = srgbToLinear(r)
            val lg = srgbToLinear(g)
            val lb = srgbToLinear(b)
            val l = cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
            val m = cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
            val s = cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
            return doubleArrayOf(
                0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
            )
        }

        private fun oklabToLinearRgb(L: Double, a: Double, b: Double): DoubleArray {
            val l1 = L + 0.3963377774 * a + 0.2158037573 * b
            val m1 = L - 0.1055613458 * a - 0.0638541728 * b
            val s1 = L - 0.0894841775 * a - 1.2914855480 * b
            val l = l1 * l1 * l1
            val m = m1 * m1 * m1
            val s = s1 * s1 * s1
            return doubleArrayOf(
                4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
            )
        }

        private fun inGamut(rgb: DoubleArray): Boolean = rgb.all { it >= -1e-4 && it <= 1.0 + 1e-4 }

        private fun argb(r: Double, g: Double, b: Double): Int {
            fun ch(v: Double) = (v.coerceIn(0.0, 1.0) * 255.0).roundToInt()
            return (0xFF shl 24) or (ch(r) shl 16) or (ch(g) shl 8) or ch(b)
        }
    }
}

/** Material 3 tone (CIELAB L*, 0..100) to OKLCH lightness; linear because both are cube roots of luminance for greys. */
fun toneToLightness(tone: Int): Double = ((tone + 16) / 116.0).coerceIn(0.0, 1.0)

/** Signed shortest angular distance from [from] to [to], in degrees. */
fun hueDelta(from: Double, to: Double): Double = ((to - from + 540.0) % 360.0) - 180.0

/**
 * Material's "harmonize": move a fixed semantic hue (green for success, red for errors) part of the
 * way toward the seed hue, at most [maxShift] degrees, so status colours belong to the palette.
 */
fun harmonizeHue(hue: Double, toward: Double?, maxShift: Double = 12.0): Double {
    if (toward == null) return norm(hue)
    val delta = hueDelta(hue, toward)
    val shift = sign(delta) * min(abs(delta) * 0.5, maxShift)
    return norm(hue + shift)
}

private fun norm(h: Double): Double = ((h % 360.0) + 360.0) % 360.0

/** Opaque ARGB with the alpha replaced. */
fun Int.withAlpha(alpha: Int): Int = (alpha.coerceIn(0, 255) shl 24) or (this and 0x00FFFFFF)

/** Rough relative luminance (0..1) of an ARGB colour, for "is this light or dark" decisions. */
fun Int.luminance(): Double = max(0.0, Oklch.fromArgb(this).l)
