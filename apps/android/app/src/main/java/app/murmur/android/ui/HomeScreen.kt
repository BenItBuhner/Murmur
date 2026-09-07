package app.murmur.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.murmur.android.BuildConfig
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.SyncStatus
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.settings.Languages
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SttKind
import app.murmur.android.settings.ThemeMode
import app.murmur.android.ui.components.Dot
import app.murmur.android.ui.components.Hairline
import app.murmur.android.ui.components.NavRow
import app.murmur.android.ui.components.Overline
import app.murmur.android.ui.components.PageMargin
import app.murmur.android.ui.components.Wordmark
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.supportsDynamicColor
import app.murmur.android.update.UpdateManager
import app.murmur.android.update.UpdatePhase
import app.murmur.android.update.UpdateState

/**
 * The index. A greeting, the live button, and one row per concern showing what it is currently
 * set to. Anything that still needs attention carries an ember dot.
 */
@Composable
fun HomeScreen(
    config: CloudConfig,
    settings: MurmurSettings,
    signedIn: Boolean,
    firstName: String?,
    syncStatus: SyncStatus?,
    onOpen: (Route) -> Unit
) {
    val c = Murmur.colors
    val context = LocalContext.current
    val permissions = rememberPermissionState()
    val dictation by DictationController.state.collectAsState()
    val updateState by UpdateManager.get(context).state.collectAsState()
    val inference = rememberInferenceView(settings)
    val modelReady = inference.sttReady
    val ready = permissions.allGranted && modelReady
    val greeting = remember { greetingFor() }

    Column(
        Modifier
            .fillMaxSize()
            .background(c.paper)
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = PageMargin).height(64.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Wordmark()
            Spacer(Modifier.weight(1f))
            StatusLine(
                dictation, ready,
                onClick = {
                    if (!ready) onOpen(
                        when {
                            !permissions.allGranted -> Route.PERMISSIONS
                            // Murmur models only need a signed-in account.
                            inference.routing.murmurStt -> Route.ACCOUNT
                            else -> Route.MODEL
                        }
                    )
                }
            )
        }

        Column(Modifier.padding(horizontal = PageMargin)) {
            Spacer(Modifier.height(20.dp))
            Text(
                "$greeting${firstName?.let { ", $it" } ?: ""}.",
                style = Murmur.type.displayMedium,
                color = c.ink
            )
            Spacer(Modifier.height(12.dp))
            Text(
                "Tap the button beside your keyboard, speak, and finished text lands where your cursor is.",
                style = Murmur.type.body,
                color = c.inkSoft
            )
            Spacer(Modifier.height(28.dp))
            PillPreview(settings, height = 128.dp)

            Spacer(Modifier.height(40.dp))
            Overline("Dictation")
            Spacer(Modifier.height(6.dp))
            Hairline()
            NavRow("Dictation button", shortPosition(settings), onClick = { onOpen(Route.BUTTON) })
            Hairline()
            NavRow(
                "Speech model",
                modelSummary(settings, inference),
                onClick = { onOpen(Route.MODEL) },
                attention = !modelReady
            )
            Hairline()
            NavRow("Language", Languages.label(settings.language), onClick = { onOpen(Route.LANGUAGE) })
            Hairline()
            NavRow(
                "Style",
                "${settings.formattingMode.displayName} formatting, ${settings.tone.displayName.lowercase()} tone",
                onClick = { onOpen(Route.STYLE) }
            )
            Hairline()
            NavRow(
                "Dictionary",
                if (settings.dictionaryEntries.isEmpty()) "Empty" else pluralize(settings.dictionaryEntries.size, "word") + if (signedIn) ", synced" else "",
                onClick = { onOpen(Route.DICTIONARY) }
            )
            Hairline()

            Spacer(Modifier.height(36.dp))
            Overline("This phone")
            Spacer(Modifier.height(6.dp))
            Hairline()
            NavRow("Appearance", appearanceSummary(settings), onClick = { onOpen(Route.APPEARANCE) })
            Hairline()
            NavRow(
                "Permissions",
                if (permissions.allGranted) "All allowed" else "${permissions.granted} of ${permissions.total} allowed",
                onClick = { onOpen(Route.PERMISSIONS) },
                attention = !permissions.allGranted
            )
            Hairline()
            NavRow("Updates", updateSummary(updateState, settings), onClick = { onOpen(Route.UPDATES) }, attention = updateState.phase == UpdatePhase.READY)
            Hairline()
            NavRow("Try it", "Test pad and sample clip", onClick = { onOpen(Route.TRY_IT) })
            Hairline()

            if (config.enabled) {
                Spacer(Modifier.height(36.dp))
                Overline("Account")
                Spacer(Modifier.height(6.dp))
                Hairline()
                NavRow(
                    "Account",
                    if (signedIn && syncStatus != null) {
                        listOfNotNull(syncStatus.user?.email ?: syncStatus.user?.name, syncLabel(syncStatus)).joinToString(", ")
                    } else {
                        "Not signed in"
                    },
                    onClick = { onOpen(Route.ACCOUNT) }
                )
                Hairline()
            }

            Spacer(Modifier.height(44.dp))
            Text("Murmur ${BuildConfig.VERSION_NAME}", style = Murmur.type.labelSmall, color = c.inkMuted)
            Spacer(Modifier.height(28.dp))
        }
    }
}

/** Live state in the corner: what the button is doing right now, or that setup is unfinished. */
@Composable
private fun StatusLine(state: DictationState, ready: Boolean, onClick: () -> Unit) {
    val c = Murmur.colors
    val (label, color, pulsing) = when {
        state is DictationState.Listening -> Triple("Listening", c.ember, true)
        state is DictationState.Processing -> Triple("Working", c.ember, true)
        !ready -> Triple("Setup", c.ember, false)
        else -> Triple("Ready", c.sage, false)
    }
    Row(
        Modifier
            .clip(CircleShape)
            .clickable(enabled = !ready, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Dot(color, size = 7.dp, pulsing = pulsing)
        Spacer(Modifier.width(9.dp))
        Overline(label, color = if (ready) c.inkSoft else c.ink)
    }
}

private fun appearanceSummary(s: MurmurSettings): String {
    val mode = when (s.themeMode) {
        ThemeMode.SYSTEM -> "Follows the system"
        ThemeMode.LIGHT -> "Light"
        ThemeMode.DARK -> "Dark"
    }
    val source = if (s.dynamicColor && supportsDynamicColor) "wallpaper colours" else "${s.accent.label.lowercase()} accent"
    return "$mode, $source"
}

private fun updateSummary(state: UpdateState, s: MurmurSettings): String = when (state.phase) {
    UpdatePhase.CHECKING -> "Checking…"
    UpdatePhase.AVAILABLE -> "Version ${state.release?.version ?: ""} available".trim()
    UpdatePhase.DOWNLOADING -> "Downloading version ${state.release?.version ?: ""}".trim()
    UpdatePhase.READY -> "Version ${state.release?.version ?: ""} ready to install".trim()
    UpdatePhase.INSTALLING -> "Installing…"
    UpdatePhase.ERROR -> "Could not check for updates"
    UpdatePhase.UP_TO_DATE, UpdatePhase.IDLE ->
        if (s.updateAutoInstall) "Up to date, installs automatically" else if (s.updateAutoCheck) "Up to date, checks automatically" else "Manual"
}

private fun modelSummary(s: MurmurSettings, inference: InferenceView): String {
    if (inference.routing.murmurStt) {
        return if (inference.sttReady) "Murmur models, ${inference.planLabel.lowercase()} plan" else "Murmur models, sign in to use them"
    }
    if (!inference.sttReady) return "Not connected"
    val model = when (s.sttKind) {
        SttKind.OPENAI_COMPATIBLE -> s.sttModel
        SttKind.DEEPGRAM -> s.sttModel.ifBlank { "nova-3" }
        SttKind.ELEVENLABS -> s.sttModel.ifBlank { "scribe_v1" }
    }
    return "${s.sttKind.displayName}, $model"
}
