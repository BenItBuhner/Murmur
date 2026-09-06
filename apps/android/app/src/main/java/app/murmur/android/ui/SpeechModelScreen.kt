package app.murmur.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttKind
import app.murmur.android.stt.SttClient
import app.murmur.android.ui.components.Chip
import app.murmur.android.ui.components.ChipRow
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.theme.Murmur
import kotlinx.coroutines.launch

@Composable
fun SpeechModelScreen(store: SettingsStore, settings: MurmurSettings, onBack: () -> Unit) {
    Screen(
        title = "Speech model",
        description = "Recordings go to a transcription service you choose. Keys stay on this phone and are never synced.",
        onBack = onBack
    ) {
        SpeechModelForm(store, settings)
    }
}

/** Provider, connection and model. Shared by the settings screen and onboarding. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SpeechModelForm(store: SettingsStore, settings: MurmurSettings, showAdvanced: Boolean = true) {
    val scope = rememberCoroutineScope()
    var models by remember { mutableStateOf<List<String>>(emptyList()) }
    var discovering by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val kind = settings.sttKind

    Group("Provider") {
        Spacer(Modifier.height(6.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (k in SttKind.entries) {
                Chip(k.displayName, selected = kind == k, onClick = {
                    models = emptyList()
                    error = null
                    store.update { s -> s.copy(sttKind = k) }
                })
            }
        }
        Spacer(Modifier.height(10.dp))
        Text(
            when (kind) {
                SttKind.OPENAI_COMPATIBLE -> "OpenAI, Groq, or any server with a /v1/audio/transcriptions endpoint, including a local whisper server."
                SttKind.DEEPGRAM -> "Deepgram's Nova models. Only the API key is required."
                SttKind.ELEVENLABS -> "ElevenLabs Scribe. Only the API key is required."
            },
            style = Murmur.type.bodySmall,
            color = Murmur.colors.inkSoft
        )
    }

    SectionGap()

    Column {
        Field(
            value = settings.sttBaseUrl,
            onValueChange = { store.update { s -> s.copy(sttBaseUrl = it) } },
            label = if (kind == SttKind.OPENAI_COMPATIBLE) "Server" else "Server (optional)",
            placeholder = when (kind) {
                SttKind.OPENAI_COMPATIBLE -> "https://api.groq.com/openai/v1"
                SttKind.DEEPGRAM -> "https://api.deepgram.com/v1"
                SttKind.ELEVENLABS -> "https://api.elevenlabs.io/v1"
            },
            helper = if (kind == SttKind.OPENAI_COMPATIBLE) null else "Leave empty to use the provider's own servers.",
            keyboardType = KeyboardType.Uri
        )
        Spacer(Modifier.height(20.dp))
        Field(
            value = settings.sttApiKey,
            onValueChange = { store.update { s -> s.copy(sttApiKey = it) } },
            label = "API key",
            placeholder = "Paste a key",
            secret = true
        )
        Spacer(Modifier.height(20.dp))
        Field(
            value = settings.sttModel,
            onValueChange = { store.update { s -> s.copy(sttModel = it) } },
            label = "Model",
            placeholder = when (kind) {
                SttKind.OPENAI_COMPATIBLE -> "whisper-large-v3-turbo"
                SttKind.DEEPGRAM -> "nova-3"
                SttKind.ELEVENLABS -> "scribe_v1"
            }
        )
        Spacer(Modifier.height(14.dp))
        Row {
            SecondaryButton(
                text = if (discovering) "Looking…" else "Discover models",
                compact = true,
                loading = discovering,
                enabled = !discovering && (kind != SttKind.OPENAI_COMPATIBLE || settings.sttBaseUrl.isNotBlank()),
                onClick = {
                    discovering = true
                    error = null
                    scope.launch {
                        try {
                            models = SttClient.listModels(sttConfig(settings))
                        } catch (e: Exception) {
                            error = "Could not list models: ${friendlyMessage(e)}"
                        } finally {
                            discovering = false
                        }
                    }
                }
            )
        }
        if (models.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            ChipRow(models.take(12), settings.sttModel) { store.update { s -> s.copy(sttModel = it) } }
        }
        error?.let {
            Spacer(Modifier.height(14.dp))
            Notice(it, NoticeTone.ERROR)
        }
    }

    if (showAdvanced) {
        SectionGap()
        Group("Resilience") {
            Spacer(Modifier.height(10.dp))
            Field(
                value = settings.sttFallbackModel,
                onValueChange = { store.update { s -> s.copy(sttFallbackModel = it) } },
                label = "Fallback model",
                placeholder = "Optional",
                helper = "Tried when the first model is unavailable or rate limited."
            )
        }
    }
}
