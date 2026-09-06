package app.murmur.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
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
import com.clerk.api.ui.ClerkColors
import com.clerk.api.ui.ClerkDesign
import com.clerk.api.ui.ClerkTheme
import com.clerk.api.ui.ClerkTypography
import com.clerk.api.ui.ClerkTypographyDefaults

/*
 * Murmur's visual language: ink on paper.
 *
 * Two near-monochrome palettes (warm ivory by day, warm black by night) with one jewel, the
 * ember the dictation pill already wears. Structure comes from hairlines and whitespace rather
 * than cards; headlines and large numerals are set in an editorial serif, everything else in the
 * system sans so the app sits naturally next to the pill it controls.
 */

@Immutable
data class MurmurColors(
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
    /** The accent; used as a fill. Same value as the overlay pill. */
    val ember: Color,
    /** The accent when it has to carry text on the paper. */
    val emberText: Color,
    /** Success. */
    val sage: Color,
    /** Errors. */
    val clay: Color,
    /** The dark stage the live pill preview sits on. */
    val stage: Color,
    /** Text on the stage and on ink fills. */
    val onStage: Color,
    val isDark: Boolean
)

val Ivory = MurmurColors(
    paper = Color(0xFFF6F3EE),
    paperRaised = Color(0xFFFCFBF8),
    ink = Color(0xFF17151A),
    inkSoft = Color(0xFF6F6A64),
    inkMuted = Color(0xFFA8A29B),
    hairline = Color(0xFFE6E1D9),
    hairlineStrong = Color(0xFFD3CCC2),
    ember = Color(0xFFFF5A36),
    emberText = Color(0xFFD5432A),
    sage = Color(0xFF3F8F63),
    clay = Color(0xFFB9463C),
    stage = Color(0xFF141416),
    onStage = Color(0xFFF1EDE6),
    isDark = false
)

val Ink = MurmurColors(
    paper = Color(0xFF0F0E10),
    paperRaised = Color(0xFF18171B),
    ink = Color(0xFFF1EDE6),
    inkSoft = Color(0xFF9B968E),
    inkMuted = Color(0xFF66625D),
    hairline = Color(0xFF262429),
    hairlineStrong = Color(0xFF38353C),
    ember = Color(0xFFFF5A36),
    emberText = Color(0xFFFF7D5F),
    sage = Color(0xFF86D3A3),
    clay = Color(0xFFE98B76),
    stage = Color(0xFF060607),
    onStage = Color(0xFFF1EDE6),
    isDark = true
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

val LocalMurmurColors = staticCompositionLocalOf { Ivory }
val LocalMurmurType = staticCompositionLocalOf { MurmurType() }

/** Access point for the design tokens: `Murmur.colors.ink`, `Murmur.type.body`. */
object Murmur {
    val colors: MurmurColors
        @Composable @ReadOnlyComposable get() = LocalMurmurColors.current
    val type: MurmurType
        @Composable @ReadOnlyComposable get() = LocalMurmurType.current
}

/** Radii used across the app. Buttons and chips are full pills; blocks are gently rounded. */
object Radii {
    val field = 14.dp
    val block = 22.dp
}

@Composable
fun MurmurTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (dark) Ink else Ivory
    val type = MurmurType()
    // Material widgets we still lean on (progress indicators, ripples, Clerk's views) read these.
    val scheme = if (dark) {
        darkColorScheme(
            primary = colors.ink,
            onPrimary = colors.paper,
            secondary = colors.inkSoft,
            background = colors.paper,
            onBackground = colors.ink,
            surface = colors.paper,
            onSurface = colors.ink,
            surfaceVariant = colors.paperRaised,
            onSurfaceVariant = colors.inkSoft,
            outline = colors.hairlineStrong,
            outlineVariant = colors.hairline,
            error = colors.clay
        )
    } else {
        lightColorScheme(
            primary = colors.ink,
            onPrimary = colors.paper,
            secondary = colors.inkSoft,
            background = colors.paper,
            onBackground = colors.ink,
            surface = colors.paper,
            onSurface = colors.ink,
            surfaceVariant = colors.paperRaised,
            onSurfaceVariant = colors.inkSoft,
            outline = colors.hairlineStrong,
            outlineVariant = colors.hairline,
            error = colors.clay
        )
    }
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
    CompositionLocalProvider(
        LocalMurmurColors provides colors,
        LocalMurmurType provides type
    ) {
        MaterialTheme(colorScheme = scheme, typography = material) {
            CompositionLocalProvider(
                LocalContentColor provides colors.ink,
                LocalTextStyle provides type.body,
                content = content
            )
        }
    }
}

/** Clerk's prebuilt sign-in dressed in the same paper and ink as the rest of the app. */
fun clerkTheme(): ClerkTheme {
    fun palette(c: MurmurColors) = ClerkColors(
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
    val type = MurmurType()
    return ClerkTheme(
        colors = palette(Ivory),
        lightColors = palette(Ivory),
        darkColors = palette(Ink),
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
