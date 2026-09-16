package app.murmur.android.overlay

import android.content.Context
import android.content.res.Resources
import android.hardware.display.DisplayManager
import android.os.Build
import android.util.DisplayMetrics
import android.view.Display
import android.view.RoundedCorner
import android.view.WindowManager
import kotlin.math.max
import kotlin.math.min

/**
 * Measures the device for [OverlayDefaults]: the whole display in dp, held upright, and the
 * radius of its bottom-left rounded corner. Never throws; whatever cannot be read is reported as
 * unknown (a square corner, or the app's own display metrics) so the defaults still come out sane.
 */
object DeviceDisplay {
    fun geometry(context: Context): DisplayGeometry {
        val app = context.applicationContext
        val density = app.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
        val (w, h) = screenPx(app)
        return DisplayGeometry(
            widthDp = min(w, h) / density,
            heightDp = max(w, h) / density,
            cornerRadiusDp = cornerRadiusPx(app) / density,
            model = Build.MODEL ?: ""
        )
    }

    /** The real size of the default display in pixels (both dimensions; the caller sorts them). */
    private fun screenPx(context: Context): Pair<Int, Int> {
        val fromWindow = runCatching {
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bounds = wm.maximumWindowMetrics.bounds
                bounds.width() to bounds.height()
            } else {
                val display = (context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager)
                    .getDisplay(Display.DEFAULT_DISPLAY)
                val metrics = DisplayMetrics()
                @Suppress("DEPRECATION")
                display.getRealMetrics(metrics)
                metrics.widthPixels to metrics.heightPixels
            }
        }.getOrNull()
        if (fromWindow != null && fromWindow.first > 0 && fromWindow.second > 0) return fromWindow
        val dm = context.resources.displayMetrics
        return dm.widthPixels to dm.heightPixels
    }

    /**
     * Radius of the display's bottom-left rounded corner in pixels: what the system reports through
     * WindowInsets on Android 12 and later, else the framework's own `rounded_corner_radius`
     * dimensions (the values SystemUI draws its corners from, present since Android 9), else 0.
     */
    fun cornerRadiusPx(context: Context): Int {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val reported = runCatching {
                val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                wm.maximumWindowMetrics.windowInsets.getRoundedCorner(RoundedCorner.POSITION_BOTTOM_LEFT)?.radius
            }.getOrNull()
            if (reported != null && reported > 0) return reported
        }
        return frameworkCornerRadiusPx()
    }

    private fun frameworkCornerRadiusPx(): Int {
        val system = Resources.getSystem()
        for (name in FRAMEWORK_CORNER_DIMENS) {
            val px = runCatching {
                val id = system.getIdentifier(name, "dimen", "android")
                if (id == 0) 0 else system.getDimensionPixelSize(id)
            }.getOrDefault(0)
            if (px > 0) return px
        }
        return 0
    }

    private val FRAMEWORK_CORNER_DIMENS = listOf("rounded_corner_radius_bottom", "rounded_corner_radius")
}
