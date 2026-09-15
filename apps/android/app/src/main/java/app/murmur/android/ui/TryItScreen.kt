package app.murmur.android.ui

import android.content.Context
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.murmur.android.BuildConfig
import app.murmur.android.audio.SAMPLE_RATE
import app.murmur.android.audio.Wav
import app.murmur.android.inference.InferenceRouter
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.text.AppCategory
import app.murmur.android.text.AppContext
import app.murmur.android.text.DictionaryTerm
import app.murmur.android.text.Engine
import app.murmur.android.text.FormatContext
import app.murmur.android.text.FormatInput
import app.murmur.android.text.FormatOutcome
import app.murmur.android.text.basicCleanup
import app.murmur.android.text.prepareTranscript
import app.murmur.android.text.resolveStyle
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Hairline
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.PrimaryButton
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.ToggleRow
import app.murmur.android.ui.theme.Murmur
import kotlinx.coroutines.launch

@Composable
fun TryItScreen(store: SettingsStore, settings: MurmurSettings, nav: TopNav) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val inference = rememberInferenceView(settings)
    var pad by remember { mutableStateOf("") }
    var testing by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }

    Screen(
        title = "Try it",
        description = "Tap into the pad. The dictation button appears beside your keyboard: tap it, speak, tap again.",
        nav = nav
    ) {
        Field(
            value = pad,
            onValueChange = { pad = it },
            placeholder = "Your words will appear here.",
            singleLine = false,
            minLines = 6
        )

        SectionGap()

        Group("Sample clip") {
            Spacer(Modifier.height(8.dp))
            Text(
                "Runs a bundled recording through your speech model and formatter and reports the real latencies, no microphone needed.",
                style = Murmur.type.bodySmall,
                color = Murmur.colors.inkSoft
            )
            Spacer(Modifier.height(18.dp))
            PrimaryButton(
                text = if (testing) "Running…" else "Run the sample clip",
                loading = testing,
                enabled = !testing && inference.sttReady,
                modifier = Modifier.fillMaxWidth(),
                onClick = {
                    testing = true
                    result = null
                    scope.launch {
                        try {
                            result = runSampleTest(context, settings, InferenceRouter.get(context))
                            failed = false
                        } catch (e: Exception) {
                            result = friendlyMessage(e)
                            failed = true
                        }
                        testing = false
                    }
                }
            )
            if (!inference.sttReady) {
                Spacer(Modifier.height(14.dp))
                Notice(
                    if (inference.routing.murmurStt) "Sign in to use Murmur models first." else "Connect a speech model first.",
                    NoticeTone.NEUTRAL
                )
            }
            result?.let {
                Spacer(Modifier.height(16.dp))
                Notice(it, if (failed) NoticeTone.ERROR else NoticeTone.SUCCESS)
            }
        }

        // Debug builds only: release installs always record from the microphone, so a phone can
        // never be stuck dictating the sample sentence because this was left on.
        if (BuildConfig.DEBUG) {
            SectionGap()

            Group("Without a microphone") {
                Spacer(Modifier.height(6.dp))
                Hairline()
                ToggleRow(
                    "Dictate the sample clip instead",
                    settings.useFixtureAudio,
                    { v -> store.update { s -> s.copy(useFixtureAudio = v) } },
                    description = "For emulators: the button runs the bundled clip through the whole pipeline (debug builds only)."
                )
                Hairline()
            }
        }
    }
}

/** Full STT -> engine round-trip on the bundled fixture, reporting real latencies. */
private suspend fun runSampleTest(context: Context, s: MurmurSettings, router: InferenceRouter): String {
    val bytes = context.assets.open("fixtures/jfk.wav").use { it.readBytes() }
    val (pcm, rate) = Wav.decodePcm16(bytes)
    val wav = Wav.encodePcm16(Wav.resample(pcm, rate, SAMPLE_RATE), SAMPLE_RATE)
    val stt = router.transcribe(router.stt(), wav, null)
    val light = basicCleanup(prepareTranscript(stt.text).text, s.dictionaryEntries)
    var out = "Speech to text in ${stt.latencyMs} ms: ${light.text.trim()}"
    if (s.formattingMode != FormattingMode.SMART) return out
    val app = AppContext("test", AppCategory.UNKNOWN)
    val style = resolveStyle(s, app)
    val input = FormatInput(
        transcript = stt.text,
        mode = FormattingMode.SMART,
        context = FormatContext(
            category = app.category,
            tone = style.tone,
            // The bundled sample clip is English regardless of the dictation language setting.
            language = "en",
            instructions = style.instructions.takeIf { it.isNotEmpty() },
            dictionary = s.dictionaryEntries.map { DictionaryTerm(it.word, it.aliases, it.fuzzy) }
        ),
        dictionary = s.dictionaryEntries
    )
    val formatted = try {
        router.formatter().format(input)
    } catch (e: Exception) {
        return out + "\nFormatter skipped: ${friendlyMessage(e)}"
    }
    out += when (formatted.status.outcome) {
        FormatOutcome.USED -> "\nFormatted in ${formatted.llmMs} ms" +
            (formatted.status.retriedAfter?.let { " (after a strict retry: $it)" } ?: "") + ": ${formatted.text}"
        FormatOutcome.REJECTED -> "\nFormatter output rejected (${formatted.status.detail}); the rule-based text was kept."
        FormatOutcome.FAILED -> "\nFormatter failed (${formatted.status.detail}); the rule-based text was kept."
        FormatOutcome.SKIPPED -> "\nFormatter skipped: ${formatted.status.detail}"
    }
    return out
}
