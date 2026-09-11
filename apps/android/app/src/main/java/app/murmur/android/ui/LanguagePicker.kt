package app.murmur.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.murmur.android.settings.Languages
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Check
import app.murmur.android.ui.components.ChevronDown
import app.murmur.android.ui.components.Overline
import app.murmur.android.ui.theme.Elevation
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii
import app.murmur.android.ui.theme.Space

/**
 * Picker for the dictation language (`MurmurSettings.language`). One setting feeds both the speech
 * model and the formatting model; it is synced with the account like the other style preferences.
 * A well like every field, opening a floating menu at the same radius; its items are inset one
 * step and take the next radius down.
 */
@Composable
fun LanguagePicker(store: SettingsStore, settings: MurmurSettings, showHint: Boolean = true) {
    val c = Murmur.colors
    var expanded by remember { mutableStateOf(false) }
    Column {
        if (showHint) {
            Text(
                if (Languages.name(settings.language) == null) {
                    "The speech model guesses the language of each dictation. Fine if you switch languages " +
                        "mid-sentence; pick your language if unclear speech sometimes comes back in the wrong one."
                } else {
                    "The speech model is locked to this language and the formatting model is told to stay in it, " +
                        "so mumbled words are fixed instead of guessed as another language."
                },
                style = Murmur.type.bodySmall,
                color = c.inkSoft
            )
            Spacer(Modifier.height(16.dp))
        }
        Overline("Dictation language")
        Spacer(Modifier.height(8.dp))
        Column {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(c.paperRaised, RoundedCornerShape(Radii.field))
                    .clickable(role = Role.DropdownList, onClick = { expanded = true })
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(Languages.label(settings.language), style = Murmur.type.title, color = c.ink, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                ChevronDown(c.inkMuted)
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
                shape = RoundedCornerShape(Radii.md),
                containerColor = c.floating,
                shadowElevation = Elevation.floating,
                tonalElevation = 0.dp,
                modifier = Modifier.padding(Space.xs)
            ) {
                for ((code, name) in Languages.OPTIONS) {
                    val selected = code == settings.language
                    DropdownMenuItem(
                        text = { Text(name, style = Murmur.type.title, color = c.ink) },
                        trailingIcon = if (selected) ({ Check(c.ink) }) else null,
                        onClick = {
                            store.update { s -> s.copy(language = code) }
                            expanded = false
                        },
                        modifier = Modifier
                            .background(if (selected) c.paperRaised else c.floating, RoundedCornerShape(Radii.nested(Radii.md, Space.xs)))
                    )
                }
            }
        }
    }
}
