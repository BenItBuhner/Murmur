package app.murmur.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.SyncPhase
import app.murmur.android.cloud.SyncStatus
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.ControlRow
import app.murmur.android.ui.components.Dot
import app.murmur.android.ui.components.Hairline
import app.murmur.android.ui.components.PrimaryButton
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Paper
import com.clerk.api.Clerk
import kotlinx.coroutines.launch

fun syncLabel(status: SyncStatus): String = when (status.phase) {
    SyncPhase.SYNCED -> "Synced"
    SyncPhase.SYNCING -> "Syncing ${status.pendingOps}…"
    SyncPhase.CONNECTING -> "Connecting…"
    SyncPhase.OFFLINE -> if (status.pendingOps > 0) "Offline, ${status.pendingOps} pending" else "Offline"
    SyncPhase.ERROR -> "Sync issue: ${status.error ?: "retrying"}"
    SyncPhase.SIGNED_OUT -> "Signed out"
    SyncPhase.DISABLED -> "Local"
}

@Composable
fun syncColor(status: SyncStatus, c: Paper = Murmur.colors): Color = when (status.phase) {
    SyncPhase.SYNCED -> c.sage
    SyncPhase.ERROR -> c.clay
    SyncPhase.SYNCING, SyncPhase.CONNECTING -> c.ember
    else -> c.inkMuted
}

@Composable
fun AccountScreen(config: CloudConfig, store: SettingsStore, onBack: () -> Unit, onSignIn: () -> Unit) {
    val sync = CloudSync.get()
    val status by (sync?.status ?: return).collectAsState()
    val user by Clerk.userFlow.collectAsState()
    val settings by store.flow.collectAsState()
    val scope = rememberCoroutineScope()
    val c = Murmur.colors

    if (user == null) {
        Screen(
            title = "Account",
            description = "You are using Murmur without an account. Everything stays on this phone.",
            onBack = onBack
        ) {
            Text(
                "Sign in to carry your dictionary and style to your other devices. The words already on this phone are merged into the account the first time.",
                style = Murmur.type.body,
                color = c.inkSoft
            )
            Spacer(Modifier.height(28.dp))
            PrimaryButton("Sign in or create an account", onClick = onSignIn, modifier = Modifier.fillMaxWidth())
        }
        return
    }

    val name = status.user?.name
        ?: listOfNotNull(user?.firstName, user?.lastName).joinToString(" ").ifBlank { "Your account" }
    val email = status.user?.email ?: user?.primaryEmailAddress?.emailAddress

    Screen(title = "Account", onBack = onBack) {
        Text(name, style = Murmur.type.displaySmall, color = c.ink)
        if (email != null) {
            Spacer(Modifier.height(6.dp))
            Text(email, style = Murmur.type.body, color = c.inkSoft)
        }

        SectionGap()

        Column {
            Hairline()
            ControlRow("Sync", description = "Dictionary and style preferences. API keys stay on this phone.") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Dot(syncColor(status), size = 6.dp, pulsing = status.phase == SyncPhase.SYNCING)
                    Spacer(Modifier.width(8.dp))
                    Text(syncLabel(status), style = Murmur.type.labelSmall, color = c.inkSoft)
                }
            }
            Hairline()
            ControlRow("Devices") {
                Text(pluralize(status.devices.size, "device"), style = Murmur.type.labelSmall, color = c.inkSoft)
            }
            Hairline()
            ControlRow("Dictionary") {
                Text(pluralize(settings.dictionaryEntries.size, "word"), style = Murmur.type.labelSmall, color = c.inkSoft)
            }
            Hairline()
        }

        Spacer(Modifier.height(28.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SecondaryButton("Sync now", onClick = { sync.syncNow() })
            SecondaryButton("Sign out", onClick = { scope.launch { sync.signOut() } })
        }

        SectionGap()

        Text("Instance", style = Murmur.type.overline, color = c.inkMuted)
        Spacer(Modifier.height(6.dp))
        Text(config.convexUrl, style = Murmur.type.bodySmall, color = c.inkMuted)
    }
}
