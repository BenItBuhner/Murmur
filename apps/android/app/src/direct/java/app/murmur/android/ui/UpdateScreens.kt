package app.murmur.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.PrimaryButton
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.TextLink
import app.murmur.android.ui.components.ToggleRow
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.update.UpdateManager
import app.murmur.android.update.UpdatePhase
import app.murmur.android.update.UpdateState
import kotlinx.coroutines.launch

private fun megabytes(bytes: Long): String = "%.1f MB".format(bytes / (1024f * 1024f))

private fun headline(s: UpdateState): String {
    val v = s.release?.version
    return when (s.phase) {
        UpdatePhase.CHECKING -> "Murmur ${s.currentVersion}"
        UpdatePhase.UP_TO_DATE -> "Murmur ${s.currentVersion} is up to date"
        UpdatePhase.AVAILABLE -> "Murmur $v is available"
        UpdatePhase.DOWNLOADING -> "Downloading Murmur $v…"
        UpdatePhase.READY -> if (s.canInstall) "Murmur $v is ready to install" else "Murmur $v downloaded"
        UpdatePhase.INSTALLING -> "Installing Murmur $v…"
        else -> "Murmur ${s.currentVersion}"
    }
}

private fun detail(s: UpdateState): String {
    val r = s.release
    return when (s.phase) {
        UpdatePhase.CHECKING -> "Checking GitHub for new releases…"
        UpdatePhase.UP_TO_DATE, UpdatePhase.IDLE ->
            if (s.lastCheckedAt > 0) "Checked ${relative(s.lastCheckedAt)}" else "Not checked yet."
        UpdatePhase.AVAILABLE -> when {
            r?.apk == null -> "This release has no Android build yet. Open the release page for details."
            r.sha256 == null ->
                "${r.checksumProblem ?: "Murmur cannot verify this build."} Open the release page to install it yourself."
            else -> "${if (r.prerelease) "Pre-release · " else ""}${megabytes(r.apk.size)}"
        }
        UpdatePhase.DOWNLOADING -> {
            val total = r?.apk?.size ?: 0L
            if (total > 0) "${(s.progress * 100).toInt()}% · ${megabytes(s.downloadedBytes)} of ${megabytes(total)}"
            else megabytes(s.downloadedBytes)
        }
        UpdatePhase.READY -> when {
            s.needsInstallPermission -> "Downloaded and verified. Android asks you to allow updates from Murmur before the first install."
            !s.canInstall -> "Murmur could not verify this download, so it will not install it."
            else -> "Downloaded and verified. Tap Install when it suits you; the system installer takes it from there."
        }
        UpdatePhase.INSTALLING -> "The system installer is taking over; Murmur restarts when it is done."
        UpdatePhase.ERROR -> s.error ?: "Something went wrong."
    }
}

private fun relative(ts: Long): String {
    val min = (System.currentTimeMillis() - ts) / 60_000
    return when {
        min < 1 -> "just now"
        min < 60 -> "$min min ago"
        min < 24 * 60 -> "${min / 60}h ago"
        else -> "${min / (24 * 60)}d ago"
    }
}

/**
 * The Updates section: the current state and its actions in one card, the three device
 * preferences in another. Drawn with the app's own pieces, like every other screen. The Install
 * button here is the only thing in the app that starts an install ([UpdateManager.install]).
 */
@Composable
fun UpdatesSection(store: SettingsStore, settings: MurmurSettings, manager: UpdateManager = UpdateManager.get(LocalContext.current)) {
    val context = LocalContext.current
    val state by manager.state.collectAsState()
    val scope = rememberCoroutineScope()
    val c = Murmur.colors

    Group("This install") {
        Text(headline(state), style = Murmur.type.title, color = c.ink)
        Spacer(Modifier.height(4.dp))
        Text(detail(state), style = Murmur.type.bodySmall, color = if (state.phase == UpdatePhase.ERROR) c.clay else c.inkSoft)
        if (state.phase != UpdatePhase.ERROR && state.error != null) {
            Spacer(Modifier.height(6.dp))
            Notice(state.error!!, NoticeTone.ERROR)
        }
        state.updatedFrom?.let {
            Spacer(Modifier.height(6.dp))
            Notice("Updated from $it to ${state.currentVersion}.", NoticeTone.SUCCESS)
        }
        if (state.phase == UpdatePhase.DOWNLOADING) {
            Spacer(Modifier.height(14.dp))
            ProgressBar(state.progress)
        }
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            when (state.phase) {
                UpdatePhase.AVAILABLE -> {
                    // Only a build the release carries a checksum for is worth downloading: nothing else can be installed.
                    if (state.release?.apk != null && state.release?.sha256 != null) {
                        SecondaryButton("Download", compact = true, onClick = { manager.download() })
                    } else {
                        SecondaryButton("View release", compact = true, onClick = { manager.openReleasePage(context) })
                    }
                    TextLink("Skip", onClick = { manager.skip() })
                }
                UpdatePhase.DOWNLOADING -> SecondaryButton("Cancel", compact = true, onClick = { manager.cancelDownload() })
                UpdatePhase.READY -> {
                    when {
                        state.needsInstallPermission -> PrimaryButton("Allow updates", onClick = { manager.requestInstallPermission(context) }, modifier = Modifier.height(36.dp))
                        state.canInstall -> PrimaryButton("Install", onClick = { manager.install() }, modifier = Modifier.height(36.dp))
                        else -> SecondaryButton("View release", compact = true, onClick = { manager.openReleasePage(context) })
                    }
                    TextLink("Skip", onClick = { manager.skip() })
                }
                UpdatePhase.INSTALLING, UpdatePhase.CHECKING -> SecondaryButton(
                    if (state.phase == UpdatePhase.CHECKING) "Checking…" else "Installing…",
                    compact = true,
                    enabled = false,
                    loading = true,
                    onClick = {}
                )
                else -> SecondaryButton(
                    if (state.phase == UpdatePhase.ERROR) "Try again" else "Check for updates",
                    compact = true,
                    onClick = { scope.launch { manager.check(manual = true) } }
                )
            }
            if (state.release != null && state.phase != UpdatePhase.DOWNLOADING) {
                TextLink("Notes", onClick = { manager.openReleasePage(context) })
            }
        }
    }

    SectionGap()

    Group("Preferences", rows = true) {
        ToggleRow(
            "Check automatically",
            settings.updateAutoCheck,
            { store.update { s -> s.copy(updateAutoCheck = it) } },
            description = "When Murmur opens, and once a day while the dictation service runs."
        )
        ToggleRow(
            "Download updates automatically",
            settings.updateAutoDownload,
            { store.update { s -> s.copy(updateAutoDownload = it) } },
            description = "Fetches new versions in the background and lets you know when one is ready. Nothing installs until you tap Install here."
        )
        ToggleRow(
            "Include pre-releases",
            settings.updateIncludePrereleases,
            {
                store.update { s -> s.copy(updateIncludePrereleases = it) }
                if (settings.updateAutoCheck) manager.checkAsync(manual = false)
            },
            description = "Offer beta builds as well as stable releases."
        )
    }
}

/** A thin track (a well) with an ink fill: the download so far. */
@Composable
private fun ProgressBar(progress: Float) {
    val c = Murmur.colors
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(6.dp)
            .clip(CircleShape)
            .background(c.paperRaised)
    ) {
        val w = size.width * progress.coerceIn(0f, 1f)
        if (w > 0f) drawRoundRect(c.ink, size = Size(w, size.height), cornerRadius = CornerRadius(size.height / 2f))
    }
}
