package app.murmur.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.murmur.android.settings.DictionaryCodec
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Card
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.ListCard
import app.murmur.android.ui.components.ListRow
import app.murmur.android.ui.components.Overline
import app.murmur.android.ui.components.PrimaryButton
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.TextLink
import app.murmur.android.ui.theme.Murmur

@Composable
fun DictionaryScreen(store: SettingsStore, synced: Boolean, nav: TopNav) {
    Screen(
        title = "Dictionary",
        description = if (synced) {
            "Names and terms spelled your way, on every device you sign in on."
        } else {
            "Names and terms the transcriber should get right, spelled the way you write them."
        },
        nav = nav
    ) {
        DictionaryEditor(store)
    }
}

/** Add form followed by the list. Used by the settings screen; onboarding has its own lighter form. */
@Composable
fun DictionaryEditor(store: SettingsStore) {
    val settings by store.flow.collectAsState()
    var word by remember { mutableStateOf("") }
    var aliases by remember { mutableStateOf("") }

    fun add() {
        val w = word.trim()
        if (w.isNotEmpty() && store.get().dictionaryEntries.none { it.word.equals(w, ignoreCase = true) }) {
            val entry = DictionaryCodec.newEntry(w, aliases.split(',').map { it.trim() }, fuzzy = false)
            store.update { s -> s.copy(dictionaryEntries = listOf(entry) + s.dictionaryEntries) }
        }
        word = ""
        aliases = ""
    }

    // The add form is a card; its fields are wells sunk into it.
    Card {
        Field(
            value = word,
            onValueChange = { word = it },
            label = "Word or phrase",
            placeholder = "Wispr Flow"
        )
        Spacer(Modifier.height(18.dp))
        Field(
            value = aliases,
            onValueChange = { aliases = it },
            label = "Sounds like",
            placeholder = "whisper flow, wisper flow",
            helper = "Optional. Ways it tends to be misheard, comma-separated; each is corrected to the word above."
        )
        Spacer(Modifier.height(20.dp))
        PrimaryButton("Add to dictionary", onClick = ::add, enabled = word.isNotBlank(), modifier = Modifier.fillMaxWidth())
    }

    SectionGap()

    val entries = settings.dictionaryEntries
    Overline(if (entries.isEmpty()) "Your words" else pluralize(entries.size, "word"))
    Spacer(Modifier.height(10.dp))
    if (entries.isEmpty()) {
        Text(
            "Nothing yet. Start with your own name; speech models get it wrong more often than you would think.",
            style = Murmur.type.bodySmall,
            color = Murmur.colors.inkMuted
        )
    } else {
        // A list card: every word is a row one radius step in from the card.
        ListCard {
            for (entry in entries) {
                DictionaryRow(entry) {
                    store.update { s -> s.copy(dictionaryEntries = s.dictionaryEntries.filter { it.id != entry.id }) }
                }
            }
        }
    }
}

@Composable
private fun DictionaryRow(entry: DictionaryEntry, onRemove: () -> Unit) {
    ListRow {
        Column(Modifier.weight(1f)) {
            Text(entry.word, style = Murmur.type.headline, color = Murmur.colors.ink)
            if (entry.aliases.isNotEmpty()) {
                Spacer(Modifier.height(3.dp))
                Text(entry.aliases.joinToString(", "), style = Murmur.type.bodySmall, color = Murmur.colors.inkSoft)
            }
        }
        Spacer(Modifier.width(12.dp))
        TextLink("Remove", onClick = onRemove)
    }
}
