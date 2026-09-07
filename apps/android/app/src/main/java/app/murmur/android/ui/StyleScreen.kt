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
import app.murmur.android.settings.BulletMarker
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.HesitationLevel
import app.murmur.android.settings.ListStyle
import app.murmur.android.settings.ListsMode
import app.murmur.android.settings.LlmFreedom
import app.murmur.android.settings.LlmStructure
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.NumbersMode
import app.murmur.android.settings.RepetitionScope
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.Tone
import app.murmur.android.ui.components.ChipRow
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Hairline
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.Overline
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

/** The "Repeats" control folds the on/off switch and the scope into one choice. */
private enum class Repeats(val label: String, val scope: RepetitionScope?) {
    OFF("Off", null), WORDS("Words", RepetitionScope.WORDS), PHRASES("Phrases", RepetitionScope.PHRASES), THOROUGH("Thorough", RepetitionScope.THOROUGH)
}

private fun repeatsOf(s: MurmurSettings): Repeats =
    if (!s.collapseRepeats) Repeats.OFF else Repeats.entries.first { it.scope == s.repetitionScope }

@Composable
fun StyleScreen(store: SettingsStore, settings: MurmurSettings, nav: TopNav) {
    val scope = rememberCoroutineScope()
    var llmModels by remember { mutableStateOf<List<String>>(emptyList()) }
    var discovering by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val c = Murmur.colors

    Screen(
        title = "Style",
        description = "How your words are cleaned up and shaped before they land. These choices follow your account.",
        nav = nav
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
                    FormattingMode.OFF -> "Exactly what the speech model heard, untouched. The cleanup and structure choices below still follow your account to other devices."
                    FormattingMode.LIGHT -> "Instant, rule-based cleanup and structure: fillers, hesitation, repeats, self-corrections, spoken commands, lists and numbers."
                    FormattingMode.SMART -> "The rule-based pass plus a small, fast language model that fixes punctuation, mis-hearings and tone. Falls back to Light whenever it is unsure."
                },
                style = Murmur.type.bodySmall,
                color = c.inkSoft
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
                color = c.inkSoft
            )
        }

        SectionGap()

        Group("Cleanup") {
            Spacer(Modifier.height(8.dp))
            Text(
                "Rule-based and instant; still applied when the model is off or unavailable.",
                style = Murmur.type.bodySmall,
                color = c.inkSoft
            )
            Spacer(Modifier.height(14.dp))
            Column {
                Hairline()
                ToggleRow(
                    "Remove filler words", settings.removeFillers,
                    { v -> store.update { s -> s.copy(removeFillers = v) } },
                    description = "um, uh, hmm and friends"
                )
                Hairline()
                ToggleRow(
                    "Self-corrections", settings.selfCorrections,
                    { v -> store.update { s -> s.copy(selfCorrections = v) } },
                    description = "\u201CTuesday, no, Wednesday\u201D keeps Wednesday"
                )
                Hairline()
                ToggleRow(
                    "Spoken commands", settings.spokenCommands,
                    { v -> store.update { s -> s.copy(spokenCommands = v) } },
                    description = "\u201Cnew line\u201D, \u201Cnew paragraph\u201D, \u201Cscratch that\u201D, \u201Cpress enter\u201D"
                )
                Hairline()
                ToggleRow(
                    "Capitalize sentences", settings.autoCapitalize,
                    { v -> store.update { s -> s.copy(autoCapitalize = v) } }
                )
                Hairline()
                ToggleRow(
                    "Trailing space", settings.trailingSpace,
                    { v -> store.update { s -> s.copy(trailingSpace = v) } },
                    description = "Leave a space after the text so the next dictation continues naturally"
                )
                Hairline()
            }

            Spacer(Modifier.height(28.dp))
            Overline("Hesitation")
            Spacer(Modifier.height(10.dp))
            Segmented(
                options = listOf(
                    Segment(HesitationLevel.OFF, "Off"),
                    Segment(HesitationLevel.LIGHT, "Light"),
                    Segment(HesitationLevel.THOROUGH, "Thorough")
                ),
                selected = settings.hesitations,
                onSelect = { v -> store.update { s -> s.copy(hesitations = v) } }
            )
            Spacer(Modifier.height(12.dp))
            Text(
                when (settings.hesitations) {
                    HesitationLevel.OFF -> "\u201Cyou know\u201D, \u201CI mean\u201D and friends stay as spoken."
                    HesitationLevel.LIGHT -> "Pure hesitation goes where the transcript marks a pause: \u201Cyou know\u201D, \u201CI mean\u201D, a pause-\u201Clike\u201D, \u201Clet me think\u201D, \u201Cso yeah\u201D."
                    HesitationLevel.THOROUGH -> "Also hedges and openers: \u201Csort of\u201D, \u201Cbasically\u201D, \u201CI guess\u201D, \u201COkay, so, \u2026\u201D, a trailing \u201C, yeah\u201D."
                },
                style = Murmur.type.bodySmall,
                color = c.inkSoft
            )

            Spacer(Modifier.height(28.dp))
            Overline("Repeats")
            Spacer(Modifier.height(10.dp))
            Segmented(
                options = Repeats.entries.map { Segment(it, it.label) },
                selected = repeatsOf(settings),
                onSelect = { v ->
                    store.update { s ->
                        if (v.scope == null) s.copy(collapseRepeats = false) else s.copy(collapseRepeats = true, repetitionScope = v.scope)
                    }
                }
            )
            Spacer(Modifier.height(12.dp))
            Text(
                when (repeatsOf(settings)) {
                    Repeats.OFF -> "Repeated words stay as spoken."
                    Repeats.WORDS -> "\u201Cthe the report\u201D, \u201CI, I think\u201D, part-word stutters (\u201Cth- the\u201D)."
                    Repeats.PHRASES -> "Also repeated phrases: \u201CI think, I think we should\u201D."
                    Repeats.THOROUGH -> "Also restarts: \u201CI want to, I need to go\u201D becomes \u201CI need to go\u201D."
                },
                style = Murmur.type.bodySmall,
                color = c.inkSoft
            )
        }

        SectionGap()

        Group("Structure") {
            Spacer(Modifier.height(8.dp))
            Overline("Lists", color = c.inkMuted)
            Spacer(Modifier.height(10.dp))
            Segmented(
                options = listOf(
                    Segment(ListsMode.OFF, "Off"),
                    Segment(ListsMode.SPOKEN, "Spoken"),
                    Segment(ListsMode.AUTO, "Auto")
                ),
                selected = settings.lists,
                onSelect = { v -> store.update { s -> s.copy(lists = v) } }
            )
            Spacer(Modifier.height(12.dp))
            Text(
                when (settings.lists) {
                    ListsMode.OFF -> "Never turned into a list."
                    ListsMode.SPOKEN -> "Only when you ask: \u201Cbullet point \u2026\u201D, \u201Cnumber one \u2026\u201D, \u201Cmake this a numbered list\u201D."
                    ListsMode.AUTO -> "Also when you enumerate: \u201Cfirst\u2026, second\u2026\u201D, \u201Chere are three things: a, b and c\u201D. Never in code or terminals."
                },
                style = Murmur.type.bodySmall,
                color = c.inkSoft
            )
            if (settings.lists != ListsMode.OFF) {
                Spacer(Modifier.height(24.dp))
                Overline("List style", color = c.inkMuted)
                Spacer(Modifier.height(10.dp))
                Segmented(
                    options = listOf(
                        Segment(ListStyle.AUTO, "Auto"),
                        Segment(ListStyle.BULLETS, "Bullets"),
                        Segment(ListStyle.NUMBERS, "Numbers")
                    ),
                    selected = settings.listStyle,
                    onSelect = { v -> store.update { s -> s.copy(listStyle = v) } }
                )
                if (settings.listStyle != ListStyle.NUMBERS) {
                    Spacer(Modifier.height(24.dp))
                    Overline("Bullet marker", color = c.inkMuted)
                    Spacer(Modifier.height(10.dp))
                    ChipRow(
                        items = BulletMarker.entries.map { it.symbol },
                        selected = settings.bulletMarker.symbol,
                        onSelect = { symbol -> BulletMarker.entries.first { it.symbol == symbol }.let { m -> store.update { s -> s.copy(bulletMarker = m) } } }
                    )
                }
            }

            Spacer(Modifier.height(28.dp))
            Overline("Numbers", color = c.inkMuted)
            Spacer(Modifier.height(10.dp))
            Segmented(
                options = listOf(
                    Segment(NumbersMode.OFF, "Off"),
                    Segment(NumbersMode.SMART, "Smart"),
                    Segment(NumbersMode.ALL, "All")
                ),
                selected = settings.numbers,
                onSelect = { v -> store.update { s -> s.copy(numbers = v) } }
            )
            Spacer(Modifier.height(12.dp))
            Text(
                when (settings.numbers) {
                    NumbersMode.OFF -> "Numbers stay as spoken."
                    NumbersMode.SMART -> "Digits from ten up and with units: \u201Cfive pm\u201D becomes \u201C5 pm\u201D, \u201Ctwenty three percent\u201D becomes \u201C23%\u201D, \u201Cten dollars\u201D becomes \u201C\$10\u201D."
                    NumbersMode.ALL -> "Every number becomes digits (\u201Cfive apples\u201D becomes \u201C5 apples\u201D)."
                },
                style = Murmur.type.bodySmall,
                color = c.inkSoft
            )
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

            SectionGap()

            Group("What the model may change") {
                Spacer(Modifier.height(8.dp))
                Overline("Freedom", color = c.inkMuted)
                Spacer(Modifier.height(10.dp))
                Segmented(
                    options = listOf(
                        Segment(LlmFreedom.STRICT, "Strict"),
                        Segment(LlmFreedom.BALANCED, "Balanced"),
                        Segment(LlmFreedom.NATURAL, "Natural")
                    ),
                    selected = settings.llmFreedom,
                    onSelect = { v -> store.update { s -> s.copy(llmFreedom = v) } }
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    when (settings.llmFreedom) {
                        LlmFreedom.STRICT -> "Punctuation, casing, spelling, mis-hearings, hesitation and self-corrections only."
                        LlmFreedom.BALANCED -> "Also grammar slips and missing articles; no rephrasing or politeness changes."
                        LlmFreedom.NATURAL -> "May smooth awkward phrasing; names, numbers and every point stay."
                    },
                    style = Murmur.type.bodySmall,
                    color = c.inkSoft
                )

                Spacer(Modifier.height(28.dp))
                Overline("Layout", color = c.inkMuted)
                Spacer(Modifier.height(10.dp))
                Segmented(
                    options = listOf(Segment(LlmStructure.KEEP, "Keep mine"), Segment(LlmStructure.ASSIST, "Assist")),
                    selected = settings.llmStructure,
                    onSelect = { v -> store.update { s -> s.copy(llmStructure = v) } }
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    when (settings.llmStructure) {
                        LlmStructure.KEEP -> "Your line breaks and list markers stay exactly as dictated; the model adds no lists, headings or paragraph breaks."
                        LlmStructure.ASSIST -> "When you enumerate, the model lays the items out as a list, and starts a new paragraph where a long dictation clearly changes topic."
                    },
                    style = Murmur.type.bodySmall,
                    color = c.inkSoft
                )

                Spacer(Modifier.height(28.dp))
                Field(
                    value = settings.llmInstructions,
                    onValueChange = { store.update { s -> s.copy(llmInstructions = it.take(2000)) } },
                    label = "Your instructions",
                    placeholder = "Use British spelling. Dates as 2026-09-06.",
                    helper = "Standing rules the model follows on every dictation.",
                    singleLine = false,
                    minLines = 3
                )
            }
        }
    }
}
