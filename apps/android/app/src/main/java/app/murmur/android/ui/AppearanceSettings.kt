package app.murmur.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.murmur.android.settings.AccentPreset
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.ThemeMode
import app.murmur.android.ui.theme.luminance
import app.murmur.android.ui.theme.supportsDynamicColor

/**
 * The Appearance card: light/dark/system, Material You wallpaper colours (Android 12+), and the
 * accent that seeds Murmur's own palette when wallpaper colours are off or unavailable. The screen
 * around it is the live preview.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppearanceSection(store: SettingsStore, settings: MurmurSettings) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Theme", Modifier.width(90.dp), fontSize = 13.sp, color = muted)
        for ((mode, label) in listOf(ThemeMode.SYSTEM to "System", ThemeMode.LIGHT to "Light", ThemeMode.DARK to "Dark")) {
            FilterChip(
                selected = settings.themeMode == mode,
                onClick = { store.update { s -> s.copy(themeMode = mode) } },
                label = { Text(label) },
                modifier = Modifier.padding(end = 6.dp)
            )
        }
    }

    if (supportsDynamicColor) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Wallpaper colours", fontSize = 14.sp)
                Text(
                    "Material You: the palette follows your wallpaper, like the rest of Android.",
                    fontSize = 12.sp, color = muted
                )
            }
            Switch(
                checked = settings.dynamicColor,
                onCheckedChange = { store.update { s -> s.copy(dynamicColor = it) } }
            )
        }
    } else {
        Text(
            "Wallpaper colours (Material You) need Android 12 or newer, so pick an accent instead.",
            fontSize = 12.sp, color = muted
        )
    }

    val usingAccent = !settings.dynamicColor || !supportsDynamicColor
    if (usingAccent) {
        Text("Accent", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            for (preset in AccentPreset.entries) {
                AccentSwatch(preset, selected = settings.accent == preset) {
                    store.update { s -> s.copy(accent = preset) }
                }
            }
        }
        Text(
            "${settings.accent.label}: buttons, chips, the dictation button and highlights use this colour; " +
                "backgrounds take a soft tint of it.",
            fontSize = 12.sp, color = muted
        )
    }
}

@Composable
private fun AccentSwatch(preset: AccentPreset, selected: Boolean, onSelect: () -> Unit) {
    val ring = MaterialTheme.colorScheme.onSurface
    Box(
        Modifier
            .size(32.dp)
            .then(if (selected) Modifier.border(2.dp, ring, CircleShape).padding(3.dp) else Modifier)
            .clip(CircleShape)
            .background(Color(preset.seed))
            .clickable(onClick = onSelect, role = Role.RadioButton)
            .semantics { contentDescription = preset.label },
        contentAlignment = Alignment.Center
    ) {
        if (selected) {
            Text(
                "✓",
                color = if (preset.seed.luminance() > 0.7) Color.Black.copy(alpha = 0.8f) else Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold
            )
        }
    }
}
