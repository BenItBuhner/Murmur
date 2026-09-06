package app.murmur.android.overlay

import android.content.Context
import android.os.Build
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.ui.theme.Oklch
import app.murmur.android.ui.theme.harmonizeHue
import app.murmur.android.ui.theme.schemeFromSeed
import app.murmur.android.ui.theme.withAlpha

/**
 * Colours for the floating dictation button. The pill is always dark (it sits over keyboards of
 * either brightness), so only the accent and the tint of its surface follow the theme; the pulsing
 * "recording" dot stays red because that is what it means.
 */
data class PillPalette(
    /** Mic body, confirm button, edit-mode halo and Done chip. */
    val accent: Int,
    /** Resting/listening pill body (translucent). */
    val background: Int,
    val successBackground: Int,
    val errorBackground: Int,
    val successForeground: Int,
    val errorForeground: Int
) {
    companion object {
        /** The look before any settings are known: Murmur's coral on near-black. */
        val DEFAULT = PillPalette(
            accent = 0xFFFF5A36.toInt(),
            background = 0xF2141414.toInt(),
            successBackground = 0xF20F2A1C.toInt(),
            errorBackground = 0xF23A1512.toInt(),
            successForeground = 0xFF7EE2A8.toInt(),
            errorForeground = 0xFFFF8A70.toInt()
        )
    }
}

object PillTheme {
    private const val BODY_ALPHA = 0xF2

    /**
     * Wallpaper colours when the user has them on (Android 12+): the tone-80 accent and the darkest
     * neutral, exactly what a dark Material You surface uses. Otherwise the dark scheme grown from
     * the chosen preset.
     */
    fun resolve(context: Context, settings: MurmurSettings): PillPalette {
        val accent: Int
        val body: Int
        if (settings.dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            accent = context.getColor(android.R.color.system_accent1_200)
            body = context.getColor(android.R.color.system_neutral1_900)
        } else {
            val scheme = schemeFromSeed(settings.accent.seed, dark = true)
            accent = scheme.primary
            body = scheme.surfaceContainer
        }
        return fromAccent(accent, body)
    }

    /** Status surfaces are fixed dark greens/reds nudged toward the accent's hue. */
    fun fromAccent(accent: Int, body: Int): PillPalette {
        val hue = Oklch.fromArgb(accent).h
        return PillPalette(
            accent = accent,
            background = body.withAlpha(BODY_ALPHA),
            successBackground = Oklch(0.25, 0.05, harmonizeHue(150.0, hue)).toArgb().withAlpha(BODY_ALPHA),
            errorBackground = Oklch(0.26, 0.07, harmonizeHue(25.0, hue)).toArgb().withAlpha(BODY_ALPHA),
            successForeground = Oklch(0.84, 0.12, harmonizeHue(155.0, hue)).toArgb(),
            errorForeground = Oklch(0.78, 0.13, harmonizeHue(30.0, hue)).toArgb()
        )
    }
}
