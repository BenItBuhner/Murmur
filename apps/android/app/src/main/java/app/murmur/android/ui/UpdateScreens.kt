package app.murmur.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.update.UpdateManager
import app.murmur.android.update.UpdatePhase
import app.murmur.android.update.UpdateState
import kotlinx.coroutines.launch

private val Muted = Color(0xFF9A9AA2)
private val Danger = Color(0xFFE08A8A)
private val Good = Color(0xFF7EE2A8)

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
        UpdatePhase.AVAILABLE ->
            if (r?.apk != null) "${if (r.prerelease) "Pre-release · " else ""}${megabytes(r.apk.size)}"
            else "This release has no Android build yet. Open the release page for details."
        UpdatePhase.DOWNLOADING -> {
            val total = r?.apk?.size ?: 0L
            if (total > 0) "${(s.progress * 100).toInt()}% · ${megabytes(s.downloadedBytes)} of ${megabytes(total)}"
            else megabytes(s.downloadedBytes)
        }
        UpdatePhase.READY -> when {
            s.needsInstallPermission -> "Murmur needs permission to install its own updates."
            !s.canInstall -> "This release ships no checksum file, so Murmur will not install it unattended."
            else -> "Android asks you to confirm the first update; later ones install on their own."
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

/** The Updates card of the settings screen: status, actions and the three device preferences. */
@Composable
fun UpdatesSection(store: SettingsStore, settings: MurmurSettings) {
    val context = LocalContext.current
    val manager = UpdateManager.get(context)
    val state by manager.state.collectAsState()
    val scope = rememberCoroutineScope()

    Text(headline(state), fontWeight = FontWeight.Medium, fontSize = 14.sp)
    Text(
        detail(state),
        fontSize = 12.sp,
        color = if (state.phase == UpdatePhase.ERROR) Danger else Muted
    )
    if (state.phase != UpdatePhase.ERROR && state.error != null) {
        Text(state.error!!, fontSize = 12.sp, color = Danger)
    }
    state.updatedFrom?.let {
        Text("Updated from $it to ${state.currentVersion}.", fontSize = 12.sp, color = Good)
    }
    if (state.phase == UpdatePhase.DOWNLOADING) {
        LinearProgressIndicator(
            progress = { state.progress },
            modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
            color = Accent
        )
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        when (state.phase) {
            UpdatePhase.AVAILABLE -> {
                if (state.release?.apk != null) {
                    Button(onClick = { manager.download() }, colors = ButtonDefaults.buttonColors(containerColor = Accent)) {
                        Text("Download")
                    }
                } else {
                    OutlinedButton(onClick = { manager.openReleasePage(context) }) { Text("View release") }
                }
                TextButton(onClick = { manager.skip() }) { Text("Skip") }
            }
            UpdatePhase.DOWNLOADING -> {
                OutlinedButton(onClick = { manager.cancelDownload() }) { Text("Cancel") }
            }
            UpdatePhase.READY -> {
                if (state.needsInstallPermission) {
                    Button(
                        onClick = { manager.requestInstallPermission(context) },
                        colors = ButtonDefaults.buttonColors(containerColor = Accent)
                    ) { Text("Allow updates") }
                } else if (state.canInstall) {
                    Button(onClick = { manager.install() }, colors = ButtonDefaults.buttonColors(containerColor = Accent)) {
                        Text("Install")
                    }
                } else {
                    OutlinedButton(onClick = { manager.openReleasePage(context) }) { Text("View release") }
                }
                TextButton(onClick = { manager.skip() }) { Text("Skip") }
            }
            UpdatePhase.INSTALLING, UpdatePhase.CHECKING -> {
                OutlinedButton(onClick = {}, enabled = false) {
                    Text(if (state.phase == UpdatePhase.CHECKING) "Checking…" else "Installing…")
                }
            }
            else -> {
                OutlinedButton(onClick = { scope.launch { manager.check(manual = true) } }) {
                    Text(if (state.phase == UpdatePhase.ERROR) "Try again" else "Check for updates")
                }
            }
        }
        if (state.release != null && state.phase != UpdatePhase.DOWNLOADING) {
            TextButton(onClick = { manager.openReleasePage(context) }) { Text("Notes") }
        }
    }

    ToggleRow(
        "Check automatically",
        "When Murmur opens, and once a day while the dictation service runs.",
        settings.updateAutoCheck
    ) { store.update { s -> s.copy(updateAutoCheck = it) } }
    ToggleRow(
        "Install automatically",
        "Downloads new versions and installs them once you are not dictating. The first time, Android asks you to allow updates from Murmur.",
        settings.updateAutoInstall
    ) { store.update { s -> s.copy(updateAutoInstall = it) } }
    ToggleRow(
        "Include pre-releases",
        "Offer beta builds as well as stable releases.",
        settings.updateIncludePrereleases
    ) {
        store.update { s -> s.copy(updateIncludePrereleases = it) }
        if (settings.updateAutoCheck) manager.checkAsync(manual = false)
    }
}

@Composable
private fun ToggleRow(title: String, description: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 13.sp)
            Text(description, fontSize = 11.sp, color = Muted)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
