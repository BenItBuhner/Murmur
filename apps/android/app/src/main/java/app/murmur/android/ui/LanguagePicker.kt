package app.murmur.android.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import app.murmur.android.settings.Languages
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore

/**
 * Picker for the dictation language (`MurmurSettings.language`). One setting feeds both the speech
 * model and the formatting model; it is synced with the account like the other style preferences.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LanguagePicker(store: SettingsStore, settings: MurmurSettings, showHint: Boolean = true) {
    var expanded by remember { mutableStateOf(false) }
    if (showHint) {
        Text(
            if (Languages.name(settings.language) == null) {
                "The speech model guesses the language of each dictation. Fine if you switch languages " +
                    "mid-sentence; pick your language if unclear speech sometimes comes back in the wrong one."
            } else {
                "The speech model is locked to this language and the formatting model is told to stay in it, " +
                    "so mumbled words are fixed instead of guessed as another language."
            },
            fontSize = 12.sp,
            color = Muted
        )
    }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = Languages.label(settings.language),
            onValueChange = {},
            readOnly = true,
            singleLine = true,
            label = { Text("Dictation language") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for ((code, name) in Languages.OPTIONS) {
                val selected = code == settings.language
                DropdownMenuItem(
                    text = {
                        Text(name, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
                    },
                    onClick = {
                        store.update { s -> s.copy(language = code) }
                        expanded = false
                    },
                    contentPadding = ExposedDropdownMenuDefaults.ItemContentPadding
                )
            }
        }
    }
}
