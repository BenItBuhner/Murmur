package app.murmur.android.ui.theme

import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.ThemeMode

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
    get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

@Composable
fun isDarkTheme(mode: ThemeMode): Boolean = when (mode) {
    ThemeMode.SYSTEM -> isSystemInDarkTheme()
    ThemeMode.LIGHT -> false
    ThemeMode.DARK -> true
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

    val activity = LocalActivity.current as? ComponentActivity
    LaunchedEffect(activity, dark) {
        activity?.enableEdgeToEdge(
            statusBarStyle = if (dark) SystemBarStyle.dark(TRANSPARENT) else SystemBarStyle.light(TRANSPARENT, TRANSPARENT),
            navigationBarStyle = if (dark) SystemBarStyle.dark(TRANSPARENT) else SystemBarStyle.light(TRANSPARENT, TRANSPARENT)
        )
    }

    CompositionLocalProvider(LocalMurmurColors provides extras) {
        MaterialTheme(colorScheme = scheme, content = content)
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
