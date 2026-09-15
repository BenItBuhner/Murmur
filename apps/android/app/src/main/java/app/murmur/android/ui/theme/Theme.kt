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
import androidx.compose.foundation.background
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.Dp
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
 * The screens read that scheme through a small set of editorial roles, [Paper]: the page, the
 * cards resting on it, the wells sunk into them, the ink, one accent. Structure comes from
 * surfaces and space rather than lines: nothing draws a border or a rule. Headlines and large
 * numerals are set in an editorial serif, everything else in the system sans so the app sits
 * naturally next to the pill it controls. Shape ([Radii]), space ([Space]) and elevation
 * ([Elevation]) use the same names and values as the desktop app's styles/globals.css.
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

/**
 * The roles the screens are drawn with, resolved from the active Material scheme.
 *
 * Surfaces form one hierarchy in both modes: the [paper] (canvas), a [card] resting on it, a
 * [floating] layer above that (the drawer, menus), and the [paperRaised] well sunk into whichever
 * of them holds it. Light mode steps down in tone from card to paper; dark mode steps up.
 */
@Immutable
data class Paper(
    /** Page background: the canvas. */
    val paper: Color,
    /** A raised surface resting on the paper: cards, tiles, sections, list cards. */
    val card: Color,
    /** A layer above the page: the drawer, menus and sheets. */
    val floating: Color,
    /** The well: fields, chips, the toggle track, panels sunk into a card or the paper. */
    val paperRaised: Color,
    /** Primary text and the fill of primary buttons. */
    val ink: Color,
    /** Secondary text. */
    val inkSoft: Color,
    /** Tertiary text, placeholders, disabled labels. */
    val inkMuted: Color,
    /** The one tone left for a thin mark that is not a rule: progress tracks, the focus ring. */
    val hairline: Color,
    /** A stronger version of [hairline], for the resting toggle track. */
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
    /** The stage the live pill preview sits on: a keyboard-like surface in the mode's brightness. */
    val stage: Color,
    /** Text on the stage. */
    val onStage: Color,
    val isDark: Boolean
)

/**
 * Map the Material roles onto the editorial ones. Light: paper tone 96, card tone 100 (white),
 * well tone 94. Dark: paper tone 6, card tone 12, floating and well tone 17.
 */
fun paperFrom(scheme: ColorScheme, extras: MurmurColors, dark: Boolean): Paper = Paper(
    paper = if (dark) scheme.background else scheme.surfaceContainerLow,
    card = if (dark) scheme.surfaceContainer else scheme.surfaceContainerLowest,
    floating = if (dark) scheme.surfaceContainerHigh else scheme.surfaceContainerLowest,
    paperRaised = if (dark) scheme.surfaceContainerHigh else scheme.surfaceContainer,
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
    // The pill follows the mode, so its stage does too: near-black at night, keyboard grey by day.
    stage = if (dark) scheme.surfaceContainerLowest else scheme.surfaceContainerHighest,
    onStage = if (dark) scheme.onSurface else scheme.onSurfaceVariant,
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

/**
 * Radius scale, in 4dp steps like the spacing grid, so nested corners stay concentric: a surface
 * inset by p from a corner of radius r takes radius r - p ([nested]), which always lands on the
 * scale. Nothing nested may be rounder than what holds it. Buttons, chips, badges, the toggle and
 * the dictation pill are fully round and sit outside the scale.
 */
object Radii {
    /** Key caps, the smallest nested chips. */
    val xs = 4.dp
    /** Menu items, small nested chips. */
    val sm = 8.dp
    /** Fields, menus, rows inside a card (card - cardTight). */
    val md = 12.dp
    /** A block inside a sheet. */
    val lg = 16.dp
    /** Cards, tiles, sections, list cards, the stage. */
    val xl = 20.dp
    /** Sheets and the drawer. */
    val xxl = 24.dp

    val field: Dp get() = md
    val card: Dp get() = xl
    val sheet: Dp get() = xxl

    /** The radius of something inset by [inset] from a corner of radius [outer]; never sharper than [xs]. */
    fun nested(outer: Dp, inset: Dp): Dp = (outer - inset).coerceAtLeast(xs)
}

/** Spacing roles on the 4dp grid. */
object Space {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 24.dp
    /** Padding of a card or section. */
    val card = 16.dp
    /** Padding of a list card whose rows are surfaces of their own. */
    val cardTight = 8.dp
    /** Vertical rhythm of a row inside a section. */
    val row = 14.dp
    /** Between the blocks of a screen. */
    val block = 32.dp
    /** The screen's side margin. */
    val gutter = 24.dp
}

/**
 * Elevation levels. Raised: a card resting on the paper. Floating: the drawer, menus, a lifted
 * card. Overlay: the dictation pill over other apps. Light mode casts soft shadows; dark mode
 * lifts by tone and the shadow only grounds the edge.
 */
object Elevation {
    val flat = 0.dp
    val raised = 2.dp
    val floating = 8.dp
    val overlay = 16.dp
}

/**
 * A surface at one of the elevation levels: fill, shape and shadow in one place, so a screen says
 * what a thing is rather than how it is drawn. Shadows are warm and light by day, deep at night.
 */
@Composable
fun Modifier.surface(level: Dp, shape: Shape, color: Color = Murmur.colors.card): Modifier {
    val dark = Murmur.colors.isDark
    val shadow = if (dark) Color.Black.copy(alpha = 0.55f) else Color(0xFF2A2318).copy(alpha = 0.16f)
    return this
        .then(if (level > 0.dp) Modifier.shadow(level, shape, clip = false, ambientColor = shadow, spotColor = shadow) else Modifier)
        .clip(shape)
        .background(color)
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

/**
 * The inverse of [toColorScheme], for the pill: the wallpaper scheme Compose builds is the only
 * source of Material You colours, and the pill draws from [SchemeArgb]. Success and warning are
 * grown from the scheme's primary, as [MurmurTheme] does.
 */
fun ColorScheme.toSchemeArgb(dark: Boolean): SchemeArgb {
    val extras = schemeFromSeed(primary.toArgb(), dark)
    return SchemeArgb(
        primary = primary.toArgb(),
        onPrimary = onPrimary.toArgb(),
        primaryContainer = primaryContainer.toArgb(),
        onPrimaryContainer = onPrimaryContainer.toArgb(),
        inversePrimary = inversePrimary.toArgb(),
        secondary = secondary.toArgb(),
        onSecondary = onSecondary.toArgb(),
        secondaryContainer = secondaryContainer.toArgb(),
        onSecondaryContainer = onSecondaryContainer.toArgb(),
        tertiary = tertiary.toArgb(),
        onTertiary = onTertiary.toArgb(),
        tertiaryContainer = tertiaryContainer.toArgb(),
        onTertiaryContainer = onTertiaryContainer.toArgb(),
        background = background.toArgb(),
        onBackground = onBackground.toArgb(),
        surface = surface.toArgb(),
        onSurface = onSurface.toArgb(),
        surfaceVariant = surfaceVariant.toArgb(),
        onSurfaceVariant = onSurfaceVariant.toArgb(),
        surfaceTint = surfaceTint.toArgb(),
        inverseSurface = inverseSurface.toArgb(),
        inverseOnSurface = inverseOnSurface.toArgb(),
        error = error.toArgb(),
        onError = onError.toArgb(),
        errorContainer = errorContainer.toArgb(),
        onErrorContainer = onErrorContainer.toArgb(),
        outline = outline.toArgb(),
        outlineVariant = outlineVariant.toArgb(),
        scrim = scrim.toArgb(),
        surfaceBright = surfaceBright.toArgb(),
        surfaceDim = surfaceDim.toArgb(),
        surfaceContainer = surfaceContainer.toArgb(),
        surfaceContainerHigh = surfaceContainerHigh.toArgb(),
        surfaceContainerHighest = surfaceContainerHighest.toArgb(),
        surfaceContainerLow = surfaceContainerLow.toArgb(),
        surfaceContainerLowest = surfaceContainerLowest.toArgb(),
        success = extras.success,
        onSuccess = extras.onSuccess,
        warning = extras.warning
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
        // Clerk draws borders around its fields; the well colour makes them read as fills.
        border = c.paperRaised,
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
