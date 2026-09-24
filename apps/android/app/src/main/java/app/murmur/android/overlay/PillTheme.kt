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

/**
 * Colours for the floating dictation button and its edit-mode chrome. The pill wears the same
 * palette as the app's screens, in the same brightness: light or dark (or whatever the system is
 * in), the wallpaper's colours on Android 12+ or the chosen accent preset. Over a light keyboard it
 * is a light control with dark ink; over a dark one, the reverse. Only the pulsing "recording" dot
 * (drawn by the view) stays red, because that is what it means. Whether the pill is lifted off the
 * keyboard at all ([elevated]) rides along with the colours, since the view takes them together.
 */
data class PillPalette(
    /** Whether this is the dark variant: a dark body carrying light ink. */
    val isDark: Boolean,
    /** Mic body, confirm button, edit-mode halo, selected chips and the active spot's badge. */
    val accent: Int,
    /** Icon and text on the [accent]. */
    val onAccent: Int,
    /** Resting, listening and processing pill body. Solid, like every surface here: nothing shows through. */
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
    /** The edit-mode toolbar surface. */
    val panel: Int,
    val successBackground: Int,
    val errorBackground: Int,
    val successForeground: Int,
    val errorForeground: Int,
    /**
     * The pill, its edit panel and their chips cast drop shadows, and the pill wears a light catch
     * along its top; false (the "Button shadow" setting off) draws all of them flat: the same
     * shapes and colours, nothing lifted.
     */
    val elevated: Boolean = true,
    /** Command mode (an instruction for the selected text): the desktop pill's violet body and ink. */
    val commandBackground: Int = background,
    val commandForeground: Int = ink
) {
    companion object {
        /** The look before any settings are known: Murmur's coral, dark. */
        val DEFAULT: PillPalette = PillTheme.fromScheme(schemeFromSeed(AccentPreset.CORAL.seed, dark = true), dark = true)
    }
}

object PillTheme {
    /** Whether the pill is dark under [mode], given the system's `Configuration.uiMode`. */
    fun isDark(mode: ThemeMode, uiMode: Int): Boolean = when (mode) {
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
        ThemeMode.SYSTEM -> (uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }

    /**
     * The palette the appearance settings ask for: the Material scheme the app's screens are drawn
     * with (wallpaper colours when they are on and available, otherwise the scheme grown from the
     * chosen preset), in the brightness the theme mode resolves to right now, lifted off the
     * keyboard unless the button shadow is turned off.
     */
    fun resolve(context: Context, settings: MurmurSettings): PillPalette {
        val dark = isDark(settings.themeMode, context.resources.configuration.uiMode)
        val scheme = if (settings.dynamicColor && supportsDynamicColor) {
            (if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)).toSchemeArgb(dark)
        } else {
            schemeFromSeed(settings.accent.seed, dark)
        }
        return fromScheme(scheme, dark, elevated = settings.buttonShadow)
    }

    /**
     * Material roles onto the pill: the body is a container surface (the lowest one by day, so it
     * reads as a key floating over the keyboard), ink is the on-surface pair, chips and the edit
     * panel are neighbouring containers. Status surfaces are fixed greens and reds in the mode's
     * brightness, nudged toward the accent's hue so they belong to the palette. Every surface is
     * fully opaque: the pill used to be 95 % and let a whisper of its own shadow through.
     */
    fun fromScheme(scheme: SchemeArgb, dark: Boolean, elevated: Boolean = true): PillPalette {
        val hue = Oklch.fromArgb(scheme.primary).h
        val body = if (dark) scheme.surfaceContainer else scheme.surfaceContainerLowest
        val panel = if (dark) scheme.surfaceContainerLow else scheme.surfaceContainerLowest
        return PillPalette(
            isDark = dark,
            accent = scheme.primary,
            onAccent = scheme.onPrimary,
            background = body,
            ink = scheme.onSurface,
            inkSoft = scheme.onSurfaceVariant,
            muted = scheme.outline,
            chip = scheme.surfaceContainerHighest,
            onChip = scheme.onSurface,
            panel = panel,
            // Deep surfaces with pale icons at night (the desktop pill's values); pale surfaces
            // with deep icons by day.
            successBackground = status(if (dark) 0.25 else 0.93, 0.05, 150.0, hue),
            errorBackground = status(if (dark) 0.26 else 0.93, 0.07, 25.0, hue),
            successForeground = if (dark) status(0.84, 0.12, 155.0, hue) else status(0.46, 0.12, 155.0, hue),
            errorForeground = if (dark) status(0.78, 0.13, 30.0, hue) else status(0.48, 0.16, 30.0, hue),
            elevated = elevated,
            // The desktop's --overlay-command / --overlay-command-foreground, in the mode's brightness.
            commandBackground = status(if (dark) 0.24 else 0.93, 0.06, 290.0, hue),
            commandForeground = if (dark) status(0.72, 0.16, 293.0, hue) else status(0.42, 0.16, 293.0, hue)
        )
    }

    /** A semantic colour at a fixed [hue], harmonized [toward] the accent. */
    private fun status(l: Double, c: Double, hue: Double, toward: Double): Int =
        Oklch(l, c, harmonizeHue(hue, toward)).toArgb()
}
