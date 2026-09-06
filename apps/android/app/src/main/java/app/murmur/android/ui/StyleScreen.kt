package app.murmur.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.murmur.android.llm.LlmClient
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.Tone
import app.murmur.android.ui.components.ChipRow
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Hairline
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.Segment
import app.murmur.android.ui.components.Segmented
import app.murmur.android.ui.components.ToggleRow
import app.murmur.android.ui.theme.Murmur
import kotlinx.coroutines.launch

val Tone.displayName: String
    get() = when (this) {
        Tone.AUTO -> "Auto"
        Tone.CASUAL -> "Casual"
        Tone.NEUTRAL -> "Neutral"
        Tone.PROFESSIONAL -> "Professional"
    }

val FormattingMode.displayName: String
    get() = when (this) {
        FormattingMode.OFF -> "Off"
        FormattingMode.LIGHT -> "Light"
        FormattingMode.SMART -> "Smart"
    }

@Composable
fun StyleScreen(store: SettingsStore, settings: MurmurSettings, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var llmModels by remember { mutableStateOf<List<String>>(emptyList()) }
    var discovering by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val cleanupOn = settings.formattingMode != FormattingMode.OFF

    Screen(
        title = "Style",
        description = "How your words are cleaned up and shaped before they land. These choices follow your account.",
        onBack = onBack
    ) {
        Group("Formatting") {
            Spacer(Modifier.height(8.dp))
            Segmented(
                options = FormattingMode.entries.map { Segment(it, it.displayName) },
                selected = settings.formattingMode,
                onSelect = { mode -> store.update { s -> s.copy(formattingMode = mode) } }
            )
            Spacer(Modifier.height(12.dp))
            Text(
                when (settings.formattingMode) {
                    FormattingMode.OFF -> "Exactly what the speech model heard, untouched."
                    FormattingMode.LIGHT -> "Instant, rule-based cleanup: fillers, stutters, self-corrections and spoken commands."
                    FormattingMode.SMART -> "Light cleanup plus a small, fast language model that fixes punctuation, lists and tone. Falls back to Light whenever it is unsure."
                },
                style = Murmur.type.bodySmall,
                color = Murmur.colors.inkSoft
            )
        }

        SectionGap()

        Group("Tone") {
            Spacer(Modifier.height(8.dp))
            ChipRow(
                items = Tone.entries.map { it.displayName },
                selected = settings.tone.displayName,
                onSelect = { label -> Tone.entries.first { it.displayName == label }.let { t -> store.update { s -> s.copy(tone = t) } } }
            )
            Spacer(Modifier.height(12.dp))
            Text(
                when (settings.tone) {
                    Tone.AUTO -> "Reads the app you are typing in: relaxed in chat, polished in email."
                    Tone.CASUAL -> "Relaxed and conversational, everywhere."
                    Tone.NEUTRAL -> "Plain and even; nothing added, nothing dressed up."
                    Tone.PROFESSIONAL -> "Composed and precise, everywhere."
                },
                style = Murmur.type.bodySmall,
                color = Murmur.colors.inkSoft
            )
        }

        SectionGap()

        Group("Cleanup") {
            Spacer(Modifier.height(6.dp))
            Column {
                Hairline()
                ToggleRow(
                    "Remove filler words", settings.removeFillers,
                    { v -> store.update { s -> s.copy(removeFillers = v) } },
                    description = "um, uh, you know, like",
                    enabled = cleanupOn
                )
                Hairline()
                ToggleRow(
                    "Collapse stutters", settings.collapseRepeats,
                    { v -> store.update { s -> s.copy(collapseRepeats = v) } },
                    description = "\u201Cthe the report\u201D becomes \u201Cthe report\u201D",
                    enabled = cleanupOn
                )
                Hairline()
                ToggleRow(
                    "Self-corrections", settings.selfCorrections,
                    { v -> store.update { s -> s.copy(selfCorrections = v) } },
                    description = "\u201CTuesday, no, Wednesday\u201D keeps Wednesday",
                    enabled = cleanupOn
                )
                Hairline()
                ToggleRow(
                    "Spoken commands", settings.spokenCommands,
                    { v -> store.update { s -> s.copy(spokenCommands = v) } },
                    description = "\u201Cnew line\u201D, \u201Cnew paragraph\u201D, \u201Cscratch that\u201D, \u201Cpress enter\u201D",
                    enabled = cleanupOn
                )
                Hairline()
                ToggleRow(
                    "Capitalize sentences", settings.autoCapitalize,
                    { v -> store.update { s -> s.copy(autoCapitalize = v) } },
                    enabled = cleanupOn
                )
                Hairline()
                ToggleRow(
                    "Trailing space", settings.trailingSpace,
                    { v -> store.update { s -> s.copy(trailingSpace = v) } },
                    description = "Leave a space after the text so the next dictation continues naturally"
                )
                Hairline()
            }
        }

        if (settings.formattingMode == FormattingMode.SMART) {
            SectionGap()
            Group("Formatting model") {
                Spacer(Modifier.height(6.dp))
                Hairline()
                ToggleRow(
                    "Same server as speech", settings.llmSameAsStt,
                    { v -> store.update { s -> s.copy(llmSameAsStt = v) } },
                    description = "Reuse the speech provider's URL and key"
                )
                Hairline()
                Spacer(Modifier.height(24.dp))
                if (!settings.llmSameAsStt) {
                    Field(
                        value = settings.llmBaseUrl,
                        onValueChange = { store.update { s -> s.copy(llmBaseUrl = it) } },
                        label = "Server",
                        placeholder = "https://api.groq.com/openai/v1",
                        keyboardType = KeyboardType.Uri
                    )
                    Spacer(Modifier.height(20.dp))
                    Field(
                        value = settings.llmApiKey,
                        onValueChange = { store.update { s -> s.copy(llmApiKey = it) } },
                        label = "API key",
                        placeholder = "Paste a key",
                        secret = true
                    )
                    Spacer(Modifier.height(20.dp))
                }
                Field(
                    value = settings.llmModel,
                    onValueChange = { store.update { s -> s.copy(llmModel = it) } },
                    label = "Model",
                    placeholder = "llama-3.1-8b-instant",
                    helper = "A small, fast instruct model. The deterministic cleanup always covers a slow or refused answer."
                )
                Spacer(Modifier.height(14.dp))
                val (base, _, _) = settings.llmConnection()
                Row {
                    SecondaryButton(
                        text = if (discovering) "Looking…" else "Discover models",
                        compact = true,
                        loading = discovering,
                        enabled = !discovering && base.isNotBlank(),
                        onClick = {
                            discovering = true
                            error = null
                            scope.launch {
                                try {
                                    val (b, key, _) = settings.llmConnection()
                                    llmModels = LlmClient.listModels(b, key)
                                } catch (e: Exception) {
                                    error = "Could not list models: ${friendlyMessage(e)}"
                                } finally {
                                    discovering = false
                                }
                            }
                        }
                    )
                }
                if (llmModels.isNotEmpty()) {
                    Spacer(Modifier.height(16.dp))
                    ChipRow(llmModels.take(12), settings.llmModel) { store.update { s -> s.copy(llmModel = it) } }
                }
                error?.let {
                    Spacer(Modifier.height(14.dp))
                    Notice(it, NoticeTone.ERROR)
                }
            }
        }
    }
}
