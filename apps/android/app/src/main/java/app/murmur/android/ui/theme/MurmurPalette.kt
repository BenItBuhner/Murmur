package app.murmur.android.ui.theme

import kotlin.math.max
import kotlin.math.min

/** One hue at a fixed chroma, addressed by Material tone. */
class TonalPalette(val hue: Double, val chroma: Double) {
    fun tone(t: Int): Int = Oklch(toneToLightness(t), chroma, hue).toArgb()
}

/**
 * Every Material 3 colour role as opaque ARGB. Compose's ColorScheme is built from this in
 * Theme.kt; the floating pill (a plain View) reads it directly.
 */
data class SchemeArgb(
    val primary: Int,
    val onPrimary: Int,
    val primaryContainer: Int,
    val onPrimaryContainer: Int,
    val inversePrimary: Int,
    val secondary: Int,
    val onSecondary: Int,
    val secondaryContainer: Int,
    val onSecondaryContainer: Int,
    val tertiary: Int,
    val onTertiary: Int,
    val tertiaryContainer: Int,
    val onTertiaryContainer: Int,
    val background: Int,
    val onBackground: Int,
    val surface: Int,
    val onSurface: Int,
    val surfaceVariant: Int,
    val onSurfaceVariant: Int,
    val surfaceTint: Int,
    val inverseSurface: Int,
    val inverseOnSurface: Int,
    val error: Int,
    val onError: Int,
    val errorContainer: Int,
    val onErrorContainer: Int,
    val outline: Int,
    val outlineVariant: Int,
    val scrim: Int,
    val surfaceBright: Int,
    val surfaceDim: Int,
    val surfaceContainer: Int,
    val surfaceContainerHigh: Int,
    val surfaceContainerHighest: Int,
    val surfaceContainerLow: Int,
    val surfaceContainerLowest: Int,
    /** Murmur additions: a "done" green and an attention amber, harmonized with the seed. */
    val success: Int,
    val onSuccess: Int,
    val warning: Int
)

/**
 * A Material 3 colour scheme grown from one seed colour, following the standard tone table
 * (primary 40/80, containers 90/30, surfaces 98/6, and so on). This is what devices without
 * wallpaper colours (Android 8 to 11) and users who turned dynamic colour off get.
 */
fun schemeFromSeed(seedArgb: Int, dark: Boolean): SchemeArgb {
    val seed = Oklch.fromArgb(seedArgb)
    val hue = seed.h
    // Vivid enough to read as a colour, never neon; a grey seed stays grey on purpose.
    val primaryChroma = if (seed.c < 0.04) seed.c else min(0.17, max(0.09, seed.c))
    val primary = TonalPalette(hue, primaryChroma)
    val secondary = TonalPalette(hue, primaryChroma * 0.35)
    val tertiary = TonalPalette(hue + 60.0, primaryChroma * 0.6)
    val neutral = TonalPalette(hue, 0.012)
    val neutralVariant = TonalPalette(hue, 0.024)
    val error = TonalPalette(harmonizeHue(25.0, hue), 0.19)
    val success = TonalPalette(harmonizeHue(150.0, hue), 0.14)
    val warning = TonalPalette(harmonizeHue(75.0, hue), 0.15)

    return if (!dark) SchemeArgb(
        primary = primary.tone(40),
        onPrimary = primary.tone(100),
        primaryContainer = primary.tone(90),
        onPrimaryContainer = primary.tone(10),
        inversePrimary = primary.tone(80),
        secondary = secondary.tone(40),
        onSecondary = secondary.tone(100),
        secondaryContainer = secondary.tone(90),
        onSecondaryContainer = secondary.tone(10),
        tertiary = tertiary.tone(40),
        onTertiary = tertiary.tone(100),
        tertiaryContainer = tertiary.tone(90),
        onTertiaryContainer = tertiary.tone(10),
        background = neutral.tone(98),
        onBackground = neutral.tone(10),
        surface = neutral.tone(98),
        onSurface = neutral.tone(10),
        surfaceVariant = neutralVariant.tone(90),
        onSurfaceVariant = neutralVariant.tone(30),
        surfaceTint = primary.tone(40),
        inverseSurface = neutral.tone(20),
        inverseOnSurface = neutral.tone(95),
        error = error.tone(40),
        onError = error.tone(100),
        errorContainer = error.tone(90),
        onErrorContainer = error.tone(10),
        outline = neutralVariant.tone(50),
        outlineVariant = neutralVariant.tone(80),
        scrim = neutral.tone(0),
        surfaceBright = neutral.tone(98),
        surfaceDim = neutral.tone(87),
        surfaceContainer = neutral.tone(94),
        surfaceContainerHigh = neutral.tone(92),
        surfaceContainerHighest = neutral.tone(90),
        surfaceContainerLow = neutral.tone(96),
        surfaceContainerLowest = neutral.tone(100),
        success = success.tone(40),
        onSuccess = success.tone(100),
        warning = warning.tone(50)
    ) else SchemeArgb(
        primary = primary.tone(80),
        onPrimary = primary.tone(20),
        primaryContainer = primary.tone(30),
        onPrimaryContainer = primary.tone(90),
        inversePrimary = primary.tone(40),
        secondary = secondary.tone(80),
        onSecondary = secondary.tone(20),
        secondaryContainer = secondary.tone(30),
        onSecondaryContainer = secondary.tone(90),
        tertiary = tertiary.tone(80),
        onTertiary = tertiary.tone(20),
        tertiaryContainer = tertiary.tone(30),
        onTertiaryContainer = tertiary.tone(90),
        background = neutral.tone(6),
        onBackground = neutral.tone(90),
        surface = neutral.tone(6),
        onSurface = neutral.tone(90),
        surfaceVariant = neutralVariant.tone(30),
        onSurfaceVariant = neutralVariant.tone(80),
        surfaceTint = primary.tone(80),
        inverseSurface = neutral.tone(90),
        inverseOnSurface = neutral.tone(20),
        error = error.tone(80),
        onError = error.tone(20),
        errorContainer = error.tone(30),
        onErrorContainer = error.tone(90),
        outline = neutralVariant.tone(60),
        outlineVariant = neutralVariant.tone(30),
        scrim = neutral.tone(0),
        surfaceBright = neutral.tone(24),
        surfaceDim = neutral.tone(6),
        surfaceContainer = neutral.tone(12),
        surfaceContainerHigh = neutral.tone(17),
        surfaceContainerHighest = neutral.tone(22),
        surfaceContainerLow = neutral.tone(10),
        surfaceContainerLowest = neutral.tone(4),
        success = success.tone(80),
        onSuccess = success.tone(20),
        warning = warning.tone(80)
    )
}
