package app.murmur.android.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.murmur.android.inference.Inference
import app.murmur.android.llm.LlmClient
import app.murmur.android.settings.AppRule
import app.murmur.android.settings.AppRuleCodec
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsRanges
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.Tone
import app.murmur.android.ui.components.ChipRow
import app.murmur.android.ui.components.ControlRow
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.Overline
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.SecondsControl
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.Segment
import app.murmur.android.ui.components.Segmented
import app.murmur.android.ui.components.TextLink
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
fun StyleScreen(store: SettingsStore, settings: MurmurSettings, nav: TopNav) {
    val scope = rememberCoroutineScope()
    val inference = rememberInferenceView(settings)
    var llmModels by remember { mutableStateOf<List<String>>(emptyList()) }
    var discovering by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val c = Murmur.colors

    Screen(
        title = "Style",
        description = "How your words become finished text. The formatting model reads the app you are typing in on its own; what is left to choose is how it should sound, anything you want to tell it, and any app that should be different. These choices follow your account.",
        nav = nav
    ) {
        Group("Formatting") {
            Segmented(
                options = FormattingMode.entries.map { Segment(it, it.displayName) },
                selected = settings.formattingMode,
                onSelect = { mode -> store.update { s -> s.copy(formattingMode = mode) } }
            )
            Spacer(Modifier.height(12.dp))
            Text(
                when (settings.formattingMode) {
                    FormattingMode.OFF -> "Exactly what the speech model heard, untouched."
                    FormattingMode.LIGHT -> "Instant, rule-based tidying: filler sounds, spoken commands, casing, punctuation spacing and your dictionary. Numbers and phrasing stay as heard."
                    FormattingMode.SMART -> "The formatting model turns the raw transcript into what you meant to type: fillers, stumbles and self-corrections go, numbers and lists are written the way a person types them, and the result is checked so that nothing you said, and no number, is changed or lost. Falls back to Light whenever the model misbehaves or is slow."
                },
                style = Murmur.type.bodySmall,
                color = c.inkSoft
            )
        }

        SectionGap()

        Group("Tone") {
            ChipRow(
                items = Tone.entries.map { it.displayName },
                selected = settings.tone.displayName,
                onSelect = { label -> Tone.entries.first { it.displayName == label }.let { t -> store.update { s -> s.copy(tone = t) } } }
            )
            Spacer(Modifier.height(12.dp))
            Text(
                when (settings.tone) {
                    Tone.AUTO -> "Reads the app you are typing in: relaxed in chat, polished in email, neutral elsewhere."
                    Tone.CASUAL -> "Relaxed and conversational, everywhere."
                    Tone.NEUTRAL -> "Plain and even; nothing added, nothing dressed up."
                    Tone.PROFESSIONAL -> "Composed and precise, everywhere."
                },
                style = Murmur.type.bodySmall,
                color = c.inkSoft
            )
            Spacer(Modifier.height(24.dp))
            Field(
                value = settings.llmInstructions,
                onValueChange = { store.update { s -> s.copy(llmInstructions = it.take(2000)) } },
                label = "Your instructions",
                placeholder = "Use British spelling. Dates as 2026-09-06.",
                helper = "Standing rules the model follows on every dictation, ahead of the tone.",
                singleLine = false,
                minLines = 3
            )
            Spacer(Modifier.height(6.dp))
            ToggleRow(
                "Trailing space", settings.trailingSpace,
                { v -> store.update { s -> s.copy(trailingSpace = v) } },
                description = "Leave a space after the text so the next dictation continues naturally"
            )
        }

        if (settings.formattingMode == FormattingMode.SMART) {
            SectionGap()
            if (inference.offersMurmur) {
                SourceChooser(
                    title = "Formatting model",
                    selected = if (inference.routing.murmurLlm) InferenceSource.MURMUR else InferenceSource.CUSTOM,
                    murmurMeta = inference.planTitle,
                    ownLabel = "Your own model",
                    onSelect = { source ->
                        store.update { s ->
                            when (source) {
                                InferenceSource.MURMUR -> s.copy(llmSource = InferenceSource.MURMUR)
                                // "Same server as speech" would point straight back at Murmur.
                                InferenceSource.CUSTOM -> s.copy(
                                    llmSource = InferenceSource.CUSTOM,
                                    llmSameAsStt = s.llmSameAsStt && s.sttSource != InferenceSource.MURMUR
                                )
                            }
                        }
                    }
                )
                SectionGap()
            }
            if (inference.routing.murmurLlm) Group(if (inference.offersMurmur) null else "Formatting model", rows = true) {
                ControlRow(
                    "Model",
                    description = if (inference.signedIn) "Provided by this Murmur instance on your ${inference.planTitle}. It receives the raw transcript together with where the text is going, and its answer is verified before anything is inserted."
                    else "Sign in to use Murmur models."
                ) {
                    Text(inference.status?.models?.llm ?: Inference.LLM_MODEL, style = Murmur.type.labelSmall, color = c.inkSoft)
                }
                FormattingTimeoutRow(store, settings)
            } else Group(if (inference.offersMurmur) null else "Formatting model") {
                ToggleRow(
                    "Same server as speech", settings.llmSameAsStt,
                    { v -> store.update { s -> s.copy(llmSameAsStt = v) } },
                    description = if (settings.sttSource == InferenceSource.MURMUR && inference.offersMurmur)
                        "Follow the speech model, which is Murmur's right now"
                    else "Reuse the speech provider's URL and key",
                    modifier = Modifier.padding(top = 0.dp)
                )
                Spacer(Modifier.height(10.dp))
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
                    placeholder = "openai/gpt-oss-20b",
                    helper = "A small, fast instruct model. The rule-based cleanup always covers a slow or refused answer."
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
                Spacer(Modifier.height(6.dp))
                FormattingTimeoutRow(store, settings)
            }
        }

        SectionGap()
        AppRulesGroup(store, settings)
    }
}

/** Desktop: Style → Formatting model → Timeout. Same default (8 s) and bounds (1–60 s) on both apps. */
@Composable
private fun FormattingTimeoutRow(store: SettingsStore, settings: MurmurSettings) {
    ControlRow("Timeout", description = "If the model is slower than this, the Light result is inserted instead.") {
        SecondsControl(
            value = settings.llmTimeoutMs / 1000,
            range = SettingsRanges.LLM_TIMEOUT_MS.first / 1000..SettingsRanges.LLM_TIMEOUT_MS.last / 1000,
            onChange = { seconds -> store.update { s -> s.copy(llmTimeoutMs = seconds * 1000) } },
            label = "Formatting timeout in seconds"
        )
    }
}

/**
 * Desktop: Style → Per-app rules. A rule matches on the app's package name or its name as the
 * launcher shows it; the first matching rule wins, and anything left on Default follows the
 * settings above. Rules follow the account.
 */
@Composable
private fun AppRulesGroup(store: SettingsStore, settings: MurmurSettings) {
    val c = Murmur.colors
    Group(
        "Per-app rules",
        description = "Match on the app's name or package; the first matching rule wins. Anything left on Default follows the settings above."
    ) {
        if (settings.appRules.isEmpty()) {
            Text(
                "No rules. Examples: “whatsapp” → casual; “termux” → formatting off; “gmail” → professional with extra instructions.",
                style = Murmur.type.bodySmall,
                color = c.inkSoft
            )
        } else {
            settings.appRules.forEachIndexed { index, rule ->
                if (index > 0) {
                    Spacer(Modifier.height(18.dp))
                    HorizontalDivider(color = c.hairline)
                    Spacer(Modifier.height(18.dp))
                }
                RuleEditor(
                    rule = rule,
                    onChange = { next -> store.update { s -> s.copy(appRules = s.appRules.map { if (it.id == next.id) next else it }) } },
                    onRemove = { store.update { s -> s.copy(appRules = s.appRules.filter { it.id != rule.id }) } }
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        SecondaryButton(
            text = "Add rule",
            compact = true,
            onClick = { store.update { s -> s.copy(appRules = s.appRules + AppRuleCodec.newRule()) } }
        )
    }
}

private const val DEFAULT_CHOICE = "Default"

@Composable
private fun RuleEditor(rule: AppRule, onChange: (AppRule) -> Unit, onRemove: () -> Unit) {
    val c = Murmur.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        Field(
            value = rule.match,
            onValueChange = { onChange(rule.copy(match = it)) },
            label = "App",
            placeholder = "whatsapp, gmail, termux…",
            modifier = Modifier.weight(1f)
        )
        Spacer(Modifier.width(12.dp))
        TextLink("Remove", onClick = onRemove, modifier = Modifier.padding(top = 26.dp))
    }
    Spacer(Modifier.height(16.dp))
    Overline("Tone")
    Spacer(Modifier.height(8.dp))
    val tones = listOf(DEFAULT_CHOICE) + Tone.entries.filter { it != Tone.AUTO }.map { it.displayName }
    ChipRow(tones, if (rule.tone == Tone.AUTO) DEFAULT_CHOICE else rule.tone.displayName, Modifier.testTag("rule-tone")) { label ->
        onChange(rule.copy(tone = Tone.entries.firstOrNull { it.displayName == label } ?: Tone.AUTO))
    }
    Spacer(Modifier.height(14.dp))
    Overline("Mode")
    Spacer(Modifier.height(8.dp))
    val modes = listOf(DEFAULT_CHOICE) + FormattingMode.entries.map { it.displayName }
    ChipRow(modes, rule.formatting?.displayName ?: DEFAULT_CHOICE, Modifier.testTag("rule-mode")) { label ->
        onChange(rule.copy(formatting = FormattingMode.entries.firstOrNull { it.displayName == label }))
    }
    Spacer(Modifier.height(14.dp))
    Overline("Trailing space")
    Spacer(Modifier.height(8.dp))
    val trailing = when (rule.trailingSpace) {
        null -> DEFAULT_CHOICE
        true -> "On"
        else -> "Off"
    }
    ChipRow(listOf(DEFAULT_CHOICE, "On", "Off"), trailing, Modifier.testTag("rule-trailing")) { label ->
        onChange(rule.copy(trailingSpace = when (label) { "On" -> true; "Off" -> false; else -> null }))
    }
    Spacer(Modifier.height(16.dp))
    Field(
        value = rule.instructions ?: "",
        onValueChange = { onChange(rule.copy(instructions = it.take(2000).ifBlank { null })) },
        label = "Instructions",
        placeholder = "Extra model instructions for this app only, e.g. “Keep it to one short paragraph.”",
        singleLine = false,
        minLines = 2
    )
}
