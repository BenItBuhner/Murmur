package app.murmur.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.murmur.android.settings.AccentPreset
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.ThemeMode
import app.murmur.android.ui.components.Check
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.Segment
import app.murmur.android.ui.components.Segmented
import app.murmur.android.ui.components.ToggleRow
import app.murmur.android.ui.theme.Elevation
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.luminance
import app.murmur.android.ui.theme.supportsDynamicColor
import app.murmur.android.ui.theme.surface

/**
 * The Appearance settings: light/dark/system, Material You wallpaper colours (Android 12+), and
 * the accent that seeds Murmur's own palette when wallpaper colours are off or unavailable. Drawn
 * with the same pieces as every other screen; the screen around them is the live preview.
 */
@Composable
fun AppearanceSection(store: SettingsStore, settings: MurmurSettings) {
    val c = Murmur.colors
    Group("Theme") {
        Segmented(
            options = listOf(Segment(ThemeMode.SYSTEM, "System"), Segment(ThemeMode.LIGHT, "Light"), Segment(ThemeMode.DARK, "Dark")),
            selected = settings.themeMode,
            onSelect = { mode -> store.update { s -> s.copy(themeMode = mode) } }
        )
        Spacer(Modifier.height(12.dp))
        Text("Light, dark, or whatever your system is using.", style = Murmur.type.bodySmall, color = c.inkSoft)
    }

    SectionGap()

    if (supportsDynamicColor) {
        Group("Palette", rows = true) {
            ToggleRow(
                title = "Wallpaper colours",
                description = "Material You: the palette follows your wallpaper, like the rest of Android.",
                checked = settings.dynamicColor,
                onCheckedChange = { store.update { s -> s.copy(dynamicColor = it) } }
            )
        }
        SectionGap()
    }

    val usingAccent = !settings.dynamicColor || !supportsDynamicColor
    Group(
        "Accent",
        description = if (supportsDynamicColor) {
            if (usingAccent) "Seeds Murmur's own palette while wallpaper colours are off." else "Turn wallpaper colours off to pick an accent of your own."
        } else {
            "Wallpaper colours (Material You) need Android 12 or newer, so the palette grows from an accent instead."
        }
    ) {
        AccentSwatches(
            selected = settings.accent,
            enabled = usingAccent,
            onSelect = { preset -> store.update { s -> s.copy(accent = preset) } }
        )
        Spacer(Modifier.height(12.dp))
        Text(
            "${settings.accent.label}: buttons, chips, the dictation button and highlights use this colour; " +
                "backgrounds take a soft tint of it.",
            style = Murmur.type.bodySmall,
            color = c.inkSoft
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AccentSwatches(selected: AccentPreset, enabled: Boolean, onSelect: (AccentPreset) -> Unit) {
    FlowRow(
        Modifier.padding(top = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        for (preset in AccentPreset.entries) {
            AccentSwatch(preset, selected = preset == selected, enabled = enabled) { onSelect(preset) }
        }
    }
}

/** A colour as a small raised disc; the chosen one carries a check, and a ring in the ink. */
@Composable
private fun AccentSwatch(preset: AccentPreset, selected: Boolean, enabled: Boolean, onSelect: () -> Unit) {
    val c = Murmur.colors
    val light = preset.seed.luminance() > 0.7
    Box(
        Modifier
            .size(36.dp)
            .then(if (selected) Modifier.background(c.ink, CircleShape).padding(3.dp).background(c.card, CircleShape).padding(2.dp) else Modifier)
            .surface(Elevation.raised, CircleShape, color = Color(preset.seed))
            .clickable(enabled = enabled, onClick = onSelect, role = Role.RadioButton)
            .semantics { contentDescription = preset.label }
            .clip(CircleShape),
        contentAlignment = Alignment.Center
    ) {
        if (selected) Check(if (light) Color.Black.copy(alpha = 0.8f) else Color.White, size = 14.dp)
    }
}
