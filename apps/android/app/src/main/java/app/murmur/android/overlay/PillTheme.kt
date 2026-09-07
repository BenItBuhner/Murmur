package app.murmur.android.overlay

import android.content.Context
import android.content.res.Configuration
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import app.murmur.android.settings.AccentPreset
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.ThemeMode
import app.murmur.android.ui.theme.Oklch
import app.murmur.android.ui.theme.SchemeArgb
import app.murmur.android.ui.theme.harmonizeHue
import app.murmur.android.ui.theme.schemeFromSeed
import app.murmur.android.ui.theme.supportsDynamicColor
import app.murmur.android.ui.theme.toSchemeArgb
import app.murmur.android.ui.theme.withAlpha

/**
 * Colours for the floating dictation button and its edit-mode chrome. The pill wears the same
 * palette as the app's screens, in the same brightness: light or dark (or whatever the system is
 * in), the wallpaper's colours on Android 12+ or the chosen accent preset. Over a light keyboard it
 * is a light control with dark ink; over a dark one, the reverse. Only the pulsing "recording" dot
 * (drawn by the view) stays red, because that is what it means.
 */
data class PillPalette(
    /** Whether this is the dark variant: a dark body carrying light ink. */
    val isDark: Boolean,
    /** Mic body, confirm button, edit-mode halo, selected chips and the active spot's badge. */
    val accent: Int,
    /** Icon and text on the [accent]. */
    val onAccent: Int,
    /** Resting, listening and processing pill body (translucent). */
    val background: Int,
    /** Icons, waveform, text and hairlines on the body. */
    val ink: Int,
    /** Secondary text (elapsed time, processing label) and the cancel cross. */
    val inkSoft: Int,
    /** Captions on the edit panel. */
    val muted: Int,
    /** Resting toolbar chips, inactive spot badges and the spot readout. */
    val chip: Int,
    /** Text and glyphs on a [chip]. */
    val onChip: Int,
    /** The edit-mode toolbar surface (translucent). */
    val panel: Int,
    val successBackground: Int,
    val errorBackground: Int,
    val successForeground: Int,
    val errorForeground: Int
) {
    companion object {
        /** The look before any settings are known: Murmur's coral, dark. */
        val DEFAULT: PillPalette = PillTheme.fromScheme(schemeFromSeed(AccentPreset.CORAL.seed, dark = true), dark = true)
    }
}

object PillTheme {
    private const val BODY_ALPHA = 0xF2
    private const val PANEL_ALPHA = 0xF5

    /** Whether the pill is dark under [mode], given the system's `Configuration.uiMode`. */
    fun isDark(mode: ThemeMode, uiMode: Int): Boolean = when (mode) {
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
        ThemeMode.SYSTEM -> (uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }

    /**
     * The palette the appearance settings ask for: the Material scheme the app's screens are drawn
     * with (wallpaper colours when they are on and available, otherwise the scheme grown from the
     * chosen preset), in the brightness the theme mode resolves to right now.
     */
    fun resolve(context: Context, settings: MurmurSettings): PillPalette {
        val dark = isDark(settings.themeMode, context.resources.configuration.uiMode)
        val scheme = if (settings.dynamicColor && supportsDynamicColor) {
            (if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)).toSchemeArgb(dark)
        } else {
            schemeFromSeed(settings.accent.seed, dark)
        }
        return fromScheme(scheme, dark)
    }

    /**
     * Material roles onto the pill: the body is a container surface (the lowest one by day, so it
     * reads as a key floating over the keyboard), ink is the on-surface pair, chips and the edit
     * panel are neighbouring containers. Status surfaces are fixed greens and reds in the mode's
     * brightness, nudged toward the accent's hue so they belong to the palette.
     */
    fun fromScheme(scheme: SchemeArgb, dark: Boolean): PillPalette {
        val hue = Oklch.fromArgb(scheme.primary).h
        val body = if (dark) scheme.surfaceContainer else scheme.surfaceContainerLowest
        val panel = if (dark) scheme.surfaceContainerLow else scheme.surfaceContainerLowest
        return PillPalette(
            isDark = dark,
            accent = scheme.primary,
            onAccent = scheme.onPrimary,
            background = body.withAlpha(BODY_ALPHA),
            ink = scheme.onSurface,
            inkSoft = scheme.onSurfaceVariant,
            muted = scheme.outline,
            chip = scheme.surfaceContainerHighest,
            onChip = scheme.onSurface,
            panel = panel.withAlpha(PANEL_ALPHA),
            // Deep surfaces with pale icons at night (the desktop pill's values); pale surfaces
            // with deep icons by day.
            successBackground = status(if (dark) 0.25 else 0.93, 0.05, 150.0, hue).withAlpha(BODY_ALPHA),
            errorBackground = status(if (dark) 0.26 else 0.93, 0.07, 25.0, hue).withAlpha(BODY_ALPHA),
            successForeground = if (dark) status(0.84, 0.12, 155.0, hue) else status(0.46, 0.12, 155.0, hue),
            errorForeground = if (dark) status(0.78, 0.13, 30.0, hue) else status(0.48, 0.16, 30.0, hue)
        )
    }

    /** A semantic colour at a fixed [hue], harmonized [toward] the accent. */
    private fun status(l: Double, c: Double, hue: Double, toward: Double): Int =
        Oklch(l, c, harmonizeHue(hue, toward)).toArgb()
}
