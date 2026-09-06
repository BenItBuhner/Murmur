package app.murmur.android.ui.theme

import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.annotation.ChecksSdkIntAtLeast
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.murmur.android.R
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.ThemeMode
import com.clerk.api.ui.ClerkColors
import com.clerk.api.ui.ClerkDesign
import com.clerk.api.ui.ClerkTheme
import com.clerk.api.ui.ClerkTypography
import com.clerk.api.ui.ClerkTypographyDefaults

/*
 * Murmur's visual language: ink on paper.
 *
 * Colour comes from the user's appearance settings (light/dark/system, wallpaper colours on
 * Android 12+, otherwise a Material 3 scheme grown from the chosen accent; see MurmurPalette.kt).
 * The screens read that scheme through a small set of editorial roles, [Paper]: the page, the ink
 * on it, hairlines, one accent. Structure comes from hairlines and whitespace rather than cards;
 * headlines and large numerals are set in an editorial serif, everything else in the system sans
 * so the app sits naturally next to the pill it controls.
 */

// ---- Material extras --------------------------------------------------------------------------

/** Material 3 has no "success" role; Murmur adds one (plus an attention amber), harmonized with the palette. */
@Immutable
data class MurmurColors(val success: Color, val onSuccess: Color, val warning: Color)

val LocalMurmurColors = staticCompositionLocalOf {
    MurmurColors(success = Color(0xFF7EE2A8), onSuccess = Color(0xFF00391C), warning = Color(0xFFF5C26B))
}

/** Extra colours next to [MaterialTheme.colorScheme]: `MurmurTheme.colors.success`. */
object MurmurTheme {
    val colors: MurmurColors
        @Composable get() = LocalMurmurColors.current
}

/** Wallpaper (Material You) colours exist from Android 12. */
val supportsDynamicColor: Boolean
    @ChecksSdkIntAtLeast(api = Build.VERSION_CODES.S)
    get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

@Composable
fun isDarkTheme(mode: ThemeMode): Boolean = when (mode) {
    ThemeMode.SYSTEM -> isSystemInDarkTheme()
    ThemeMode.LIGHT -> false
    ThemeMode.DARK -> true
}

// ---- editorial roles --------------------------------------------------------------------------

/** The roles the screens are drawn with, resolved from the active Material scheme. */
@Immutable
data class Paper(
    /** Page background. */
    val paper: Color,
    /** A whisper above the paper: fields, chips, the toggle track. */
    val paperRaised: Color,
    /** Primary text and the fill of primary buttons. */
    val ink: Color,
    /** Secondary text. */
    val inkSoft: Color,
    /** Tertiary text, placeholders, disabled labels. */
    val inkMuted: Color,
    /** Rules and resting borders. */
    val hairline: Color,
    /** Borders that need a little more presence (toggle track, unselected chips). */
    val hairlineStrong: Color,
    /** The accent, used as a fill: the palette's primary, which the pill wears too. */
    val ember: Color,
    /** Text on an [ember] fill. */
    val onEmber: Color,
    /** The accent when it has to carry text on the paper. */
    val emberText: Color,
    /** Success. */
    val sage: Color,
    /** Errors. */
    val clay: Color,
    /** The dark stage the live pill preview sits on. */
    val stage: Color,
    /** Text on the stage. */
    val onStage: Color,
    val isDark: Boolean
)

/** Map the Material roles onto the editorial ones. */
fun paperFrom(scheme: ColorScheme, extras: MurmurColors, dark: Boolean): Paper = Paper(
    paper = scheme.background,
    paperRaised = if (dark) scheme.surfaceContainerLow else scheme.surfaceContainerLowest,
    ink = scheme.onBackground,
    inkSoft = scheme.onSurfaceVariant,
    inkMuted = scheme.outline,
    hairline = scheme.outlineVariant,
    hairlineStrong = scheme.outline,
    ember = scheme.primary,
    onEmber = scheme.onPrimary,
    emberText = scheme.primary,
    sage = extras.success,
    clay = scheme.error,
    stage = if (dark) scheme.surfaceContainerLowest else scheme.inverseSurface,
    onStage = if (dark) scheme.onSurface else scheme.inverseOnSurface,
    isDark = dark
)

/** Instrument Serif: the display face for headlines, the wordmark and large numerals. */
val Serif = FontFamily(
    Font(R.font.instrument_serif_regular, FontWeight.Normal),
    Font(R.font.instrument_serif_italic, FontWeight.Normal, FontStyle.Italic)
)

/** The platform sans, the same family the overlay pill is drawn with. */
val Sans = FontFamily.SansSerif

private val Trim = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)
private val NoPadding = PlatformTextStyle(includeFontPadding = false)

private fun serif(size: Int, line: Int, tracking: Float = -0.015f) = TextStyle(
    fontFamily = Serif,
    fontWeight = FontWeight.Normal,
    fontSize = size.sp,
    lineHeight = line.sp,
    letterSpacing = tracking.em,
    lineHeightStyle = Trim,
    platformStyle = NoPadding
)

private fun sans(size: Int, line: Int, weight: FontWeight = FontWeight.Normal, tracking: Float = 0f) = TextStyle(
    fontFamily = Sans,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = line.sp,
    letterSpacing = tracking.em,
    lineHeightStyle = Trim,
    platformStyle = NoPadding
)

@Immutable
data class MurmurType(
    /** Hero statements ("Speak. It types."). */
    val displayLarge: TextStyle = serif(46, 48, -0.02f),
    /** Screen titles and the home greeting. */
    val displayMedium: TextStyle = serif(36, 40),
    /** Section headings inside a screen. */
    val displaySmall: TextStyle = serif(27, 32),
    /** Row titles that deserve the serif (account name, dictionary words). */
    val headline: TextStyle = serif(22, 28, -0.01f),
    /** Large numerals. */
    val numeral: TextStyle = serif(40, 44, -0.02f),
    /** Row titles and field values. */
    val title: TextStyle = sans(16, 22),
    /** Body copy. */
    val body: TextStyle = sans(15, 22),
    /** Descriptions, captions. */
    val bodySmall: TextStyle = sans(13, 18),
    /** Buttons, chips, segmented controls. */
    val label: TextStyle = sans(14, 18, FontWeight.Medium),
    /** Small labels. */
    val labelSmall: TextStyle = sans(12, 16, FontWeight.Medium),
    /** Tracked uppercase section labels; the caller uppercases the text. */
    val overline: TextStyle = sans(11, 14, FontWeight.Medium, 0.14f)
)

val LocalPaper = staticCompositionLocalOf { paperFrom(lightColorScheme(), MurmurColors(Color(0xFF3F8F63), Color.White, Color(0xFFB07A1B)), dark = false) }
val LocalMurmurType = staticCompositionLocalOf { MurmurType() }

/** Access point for the design tokens: `Murmur.colors.ink`, `Murmur.type.body`. */
object Murmur {
    val colors: Paper
        @Composable @ReadOnlyComposable get() = LocalPaper.current
    val type: MurmurType
        @Composable @ReadOnlyComposable get() = LocalMurmurType.current
}

/** Radii used across the app. Buttons and chips are full pills; blocks are gently rounded. */
object Radii {
    val field = 14.dp
    val block = 22.dp
}

/**
 * The app theme, from the user's appearance settings: light/dark/system, wallpaper colours on
 * Android 12+ when enabled, otherwise Murmur's own palette grown from the chosen accent. Also keeps
 * the status and navigation bar icons legible for the mode actually in use (a forced-dark app on a
 * light system still gets light icons).
 */
@Composable
fun MurmurTheme(settings: MurmurSettings, content: @Composable () -> Unit) {
    val dark = isDarkTheme(settings.themeMode)
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val dynamic = settings.dynamicColor && supportsDynamicColor

    val scheme = remember(dark, dynamic, settings.accent, configuration) {
        if (dynamic) {
            if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        } else {
            schemeFromSeed(settings.accent.seed, dark).toColorScheme(dark)
        }
    }
    val extras = remember(scheme, dark) {
        // Success/warning follow whichever hue the palette actually has, wallpaper or preset.
        val derived = schemeFromSeed(scheme.primary.toArgb(), dark)
        MurmurColors(Color(derived.success), Color(derived.onSuccess), Color(derived.warning))
    }
    val paper = remember(scheme, extras, dark) { paperFrom(scheme, extras, dark) }
    val type = MurmurType()
    val material = Typography(
        displayLarge = type.displayLarge,
        displayMedium = type.displayMedium,
        displaySmall = type.displaySmall,
        headlineMedium = type.headline,
        titleMedium = type.title,
        bodyLarge = type.body,
        bodyMedium = type.body,
        bodySmall = type.bodySmall,
        labelLarge = type.label,
        labelMedium = type.labelSmall,
        labelSmall = type.overline
    )

    val activity = LocalActivity.current as? ComponentActivity
    LaunchedEffect(activity, dark) {
        activity?.enableEdgeToEdge(
            statusBarStyle = if (dark) SystemBarStyle.dark(TRANSPARENT) else SystemBarStyle.light(TRANSPARENT, TRANSPARENT),
            navigationBarStyle = if (dark) SystemBarStyle.dark(TRANSPARENT) else SystemBarStyle.light(TRANSPARENT, TRANSPARENT)
        )
    }

    CompositionLocalProvider(
        LocalMurmurColors provides extras,
        LocalPaper provides paper,
        LocalMurmurType provides type
    ) {
        MaterialTheme(colorScheme = scheme, typography = material) {
            CompositionLocalProvider(
                LocalContentColor provides paper.ink,
                LocalTextStyle provides type.body,
                content = content
            )
        }
    }
}

private const val TRANSPARENT = android.graphics.Color.TRANSPARENT

fun SchemeArgb.toColorScheme(dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = Color(primary),
        onPrimary = Color(onPrimary),
        primaryContainer = Color(primaryContainer),
        onPrimaryContainer = Color(onPrimaryContainer),
        inversePrimary = Color(inversePrimary),
        secondary = Color(secondary),
        onSecondary = Color(onSecondary),
        secondaryContainer = Color(secondaryContainer),
        onSecondaryContainer = Color(onSecondaryContainer),
        tertiary = Color(tertiary),
        onTertiary = Color(onTertiary),
        tertiaryContainer = Color(tertiaryContainer),
        onTertiaryContainer = Color(onTertiaryContainer),
        background = Color(background),
        onBackground = Color(onBackground),
        surface = Color(surface),
        onSurface = Color(onSurface),
        surfaceVariant = Color(surfaceVariant),
        onSurfaceVariant = Color(onSurfaceVariant),
        surfaceTint = Color(surfaceTint),
        inverseSurface = Color(inverseSurface),
        inverseOnSurface = Color(inverseOnSurface),
        error = Color(error),
        onError = Color(onError),
        errorContainer = Color(errorContainer),
        onErrorContainer = Color(onErrorContainer),
        outline = Color(outline),
        outlineVariant = Color(outlineVariant),
        scrim = Color(scrim),
        surfaceBright = Color(surfaceBright),
        surfaceDim = Color(surfaceDim),
        surfaceContainer = Color(surfaceContainer),
        surfaceContainerHigh = Color(surfaceContainerHigh),
        surfaceContainerHighest = Color(surfaceContainerHighest),
        surfaceContainerLow = Color(surfaceContainerLow),
        surfaceContainerLowest = Color(surfaceContainerLowest)
    )
}

/** Clerk's prebuilt sign-in dressed in the same paper and ink as the rest of the app. */
@Composable
fun clerkTheme(): ClerkTheme {
    val c = Murmur.colors
    val type = Murmur.type
    // One palette for both of Clerk's modes: the app may force a mode the system is not in, and
    // the form must match the screen around it either way.
    val palette = ClerkColors(
        primary = c.ink,
        primaryForeground = c.paper,
        background = c.paper,
        input = c.paperRaised,
        inputForeground = c.ink,
        foreground = c.ink,
        mutedForeground = c.inkSoft,
        muted = c.paperRaised,
        neutral = c.inkSoft,
        border = c.hairlineStrong,
        ring = c.ink,
        secondaryButtonBackground = c.paperRaised,
        secondaryButtonForeground = c.ink,
        shadow = Color.Transparent,
        danger = c.clay,
        success = c.sage,
        warning = c.emberText
    )
    return ClerkTheme(
        colors = palette,
        lightColors = palette,
        darkColors = palette,
        typography = ClerkTypography(
            displaySmall = ClerkTypographyDefaults.displaySmall.copy(fontFamily = Serif, fontSize = 30.sp, letterSpacing = (-0.015).em),
            headlineLarge = ClerkTypographyDefaults.headlineLarge.copy(fontFamily = Serif, fontSize = 28.sp),
            headlineMedium = ClerkTypographyDefaults.headlineMedium.copy(fontFamily = Serif, fontSize = 24.sp),
            titleMedium = ClerkTypographyDefaults.titleMedium.copy(fontFamily = Sans, fontWeight = FontWeight.Medium),
            titleSmall = ClerkTypographyDefaults.titleSmall.copy(fontFamily = Sans, fontWeight = FontWeight.Medium),
            bodyLarge = ClerkTypographyDefaults.bodyLarge.copy(fontFamily = Sans),
            bodyMedium = ClerkTypographyDefaults.bodyMedium.copy(fontFamily = Sans),
            bodySmall = ClerkTypographyDefaults.bodySmall.copy(fontFamily = Sans),
            labelMedium = ClerkTypographyDefaults.labelMedium.copy(fontFamily = Sans, fontWeight = FontWeight.Medium),
            labelSmall = type.labelSmall
        ),
        design = ClerkDesign(borderRadius = Radii.field)
    )
}
