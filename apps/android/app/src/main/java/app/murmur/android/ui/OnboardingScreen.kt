package app.murmur.android.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import app.murmur.android.settings.DictionaryCodec
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.Tone
import app.murmur.android.ui.components.ChipRow
import app.murmur.android.ui.components.FeatureRow
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Hairline
import app.murmur.android.ui.components.Heading
import app.murmur.android.ui.components.PageMargin
import app.murmur.android.ui.components.PrimaryButton
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.StepIndicator
import app.murmur.android.ui.components.TextLink
import app.murmur.android.ui.components.Wordmark
import app.murmur.android.ui.theme.Murmur

private enum class Step { WELCOME, PERSONALIZE, PERMISSIONS, PROVIDER }

/**
 * First-run flow. The Personalize step is account-level (stored on the account, skipped on the
 * next device); permissions and the speech model are device-level and repeat on every install.
 */
@Composable
fun OnboardingScreen(
    store: SettingsStore,
    signedIn: Boolean,
    accountOnboarded: Boolean,
    firstName: String?,
    onFinish: () -> Unit
) {
    val settings by store.flow.collectAsState()
    val steps = remember(signedIn, accountOnboarded) {
        buildList {
            add(Step.WELCOME)
            if (signedIn && !accountOnboarded) add(Step.PERSONALIZE)
            add(Step.PERMISSIONS)
            add(Step.PROVIDER)
        }
    }
    var index by rememberSaveable { mutableIntStateOf(0) }
    val step = steps[index.coerceIn(0, steps.lastIndex)]
    val returning = signedIn && accountOnboarded
    val c = Murmur.colors

    Column(
        Modifier
            .fillMaxSize()
            .background(c.paper)
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding()
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = PageMargin).height(64.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Wordmark()
            Spacer(Modifier.weight(1f))
            StepIndicator(steps.size, index, Modifier.width(88.dp))
        }

        AnimatedContent(
            targetState = index,
            modifier = Modifier.weight(1f),
            transitionSpec = {
                val forward = targetState >= initialState
                val spec = tween<Float>(320, easing = FastOutSlowInEasing)
                (slideInHorizontally(tween(320, easing = FastOutSlowInEasing)) { if (forward) it / 6 else -it / 6 } + fadeIn(spec))
                    .togetherWith(slideOutHorizontally(tween(320, easing = FastOutSlowInEasing)) { if (forward) -it / 6 else it / 6 } + fadeOut(spec))
            },
            label = "onboarding"
        ) { i ->
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = PageMargin)
            ) {
                Spacer(Modifier.height(16.dp))
                when (steps[i.coerceIn(0, steps.lastIndex)]) {
                    Step.WELCOME -> {
                        if (returning) {
                            Text("Welcome back${firstName?.let { ", $it" } ?: ""}.", style = Murmur.type.displayLarge, color = c.ink)
                            Spacer(Modifier.height(20.dp))
                            Text(
                                "Your account is already set up: ${pluralize(settings.dictionaryEntries.size, "dictionary word")} " +
                                    "and your style are on this phone now. Two quick device steps and you are dictating.",
                                style = Murmur.type.body,
                                color = c.inkSoft
                            )
                        } else {
                            Text("Speak.", style = Murmur.type.displayLarge, color = c.ink)
                            Text("It types.", style = Murmur.type.displayLarge.copy(fontStyle = FontStyle.Italic), color = c.inkSoft)
                            Spacer(Modifier.height(20.dp))
                            Text(
                                "Tap the button beside your keyboard, say what you mean, and finished text lands where your cursor is. " +
                                    "Murmur drops the ums and the false starts on the way.",
                                style = Murmur.type.body,
                                color = c.inkSoft
                            )
                        }
                        Spacer(Modifier.height(28.dp))
                        PillPreview(settings, height = 128.dp)
                        Spacer(Modifier.height(28.dp))
                        Column {
                            Hairline()
                            FeatureRow("Tap to talk, tap again to finish")
                            Hairline()
                            FeatureRow("Your own speech model: OpenAI, Groq, Deepgram, or a local whisper server")
                            Hairline()
                            FeatureRow(
                                if (signedIn) "Your dictionary and style sync to every device you sign in on"
                                else "A personal dictionary for names and jargon"
                            )
                            Hairline()
                            FeatureRow(
                                if (signedIn) "API keys stay on this phone; only your words and settings sync"
                                else "Nothing stored anywhere but this phone"
                            )
                            Hairline()
                        }
                    }
                    Step.PERSONALIZE -> PersonalizeStep(store, firstName)
                    Step.PERMISSIONS -> {
                        Heading(
                            "Permissions",
                            "Three grants from the system: one to hear you, one to draw the button, one to type for you."
                        )
                        Spacer(Modifier.height(32.dp))
                        PermissionList()
                    }
                    Step.PROVIDER -> {
                        Heading(
                            "Speech model",
                            "Recordings go to a transcription service you choose. Keys stay on this phone. You can change any of this later."
                        )
                        Spacer(Modifier.height(32.dp))
                        SpeechModelForm(store, settings, showAdvanced = false)
                    }
                }
                Spacer(Modifier.height(32.dp))
            }
        }

        Hairline()
        Row(
            Modifier.fillMaxWidth().padding(horizontal = PageMargin, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (index > 0) TextLink("Back", onClick = { index-- })
            Spacer(Modifier.weight(1f))
            when {
                index == steps.lastIndex -> PrimaryButton("Finish", onClick = onFinish)
                index == 0 -> PrimaryButton("Begin", onClick = { index++ })
                else -> PrimaryButton("Continue", onClick = { index++ })
            }
        }
    }
}

@Composable
private fun PersonalizeStep(store: SettingsStore, firstName: String?) {
    val settings by store.flow.collectAsState()
    var terms by remember { mutableStateOf("") }
    val c = Murmur.colors

    Heading(
        "Make it yours${firstName?.let { ", $it" } ?: ""}",
        "These choices live in your account, so every device you sign in on picks them up. You only do this once."
    )
    Spacer(Modifier.height(32.dp))
    Group("Names, products and tools you say often") {
        Spacer(Modifier.height(8.dp))
        Text(
            "Speech models misspell names. Anything in your dictionary is spelled the way you wrote it.",
            style = Murmur.type.bodySmall,
            color = c.inkSoft
        )
        Spacer(Modifier.height(16.dp))
        Field(
            value = terms,
            onValueChange = { terms = it },
            placeholder = "Wispr Flow, Kubernetes, Priya",
            helper = "Comma-separated."
        )
        Spacer(Modifier.height(14.dp))
        SecondaryButton(
            "Add",
            compact = true,
            enabled = terms.isNotBlank(),
            onClick = {
                addWords(store, terms)
                terms = ""
            }
        )
        if (settings.dictionaryEntries.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            Text(
                settings.dictionaryEntries.take(12).joinToString(", ") { it.word },
                style = Murmur.type.headline,
                color = c.ink
            )
        }
    }
    SectionGap()
    Group("Default tone") {
        Spacer(Modifier.height(8.dp))
        ChipRow(
            items = Tone.entries.map { it.displayName },
            selected = settings.tone.displayName,
            onSelect = { label -> Tone.entries.first { it.displayName == label }.let { t -> store.update { s -> s.copy(tone = t) } } }
        )
        Spacer(Modifier.height(12.dp))
        Text(
            "Auto reads the app you are typing in: relaxed in chat, polished in email.",
            style = Murmur.type.bodySmall,
            color = c.inkSoft
        )
    }
}

fun addWords(store: SettingsStore, raw: String) {
    val existing = store.get().dictionaryEntries.map { it.word.lowercase() }.toSet()
    val fresh = raw.split(',', ';', '\n')
        .map { it.trim() }
        .filter { it.isNotEmpty() && it.lowercase() !in existing }
        .distinctBy { it.lowercase() }
        .map { DictionaryCodec.newEntry(it, fuzzy = true) }
    if (fresh.isEmpty()) return
    store.update { s -> s.copy(dictionaryEntries = fresh + s.dictionaryEntries) }
}
