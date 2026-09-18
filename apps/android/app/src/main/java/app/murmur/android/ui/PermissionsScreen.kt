package app.murmur.android.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import app.murmur.android.service.MurmurAccessibilityService
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Card
import app.murmur.android.ui.components.ControlRow
import app.murmur.android.ui.components.Dot
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.RowCardPadding
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.ToggleRow
import app.murmur.android.ui.theme.Murmur

data class PermissionState(val microphone: Boolean, val overlay: Boolean, val accessibility: Boolean) {
    val allGranted: Boolean get() = microphone && overlay && accessibility
    val granted: Int get() = listOf(microphone, overlay, accessibility).count { it }
    val total: Int get() = 3
}

/** The three system grants Murmur depends on, re-read every time the app comes back to the front. */
@Composable
fun rememberPermissionState(): PermissionState {
    val context = LocalContext.current
    var state by remember { mutableStateOf(readPermissions(context)) }
    LifecycleResumeEffect(Unit) {
        state = readPermissions(context)
        onPauseOrDispose { }
    }
    return state
}

private fun readPermissions(context: android.content.Context) = PermissionState(
    microphone = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
    overlay = Settings.canDrawOverlays(context),
    accessibility = MurmurAccessibilityService.isRunning
)

@Composable
fun PermissionsScreen(nav: TopNav) {
    val context = LocalContext.current
    val store = remember(context) { SettingsStore.get(context) }
    val settings by store.flow.collectAsState()
    Screen(
        title = "Permissions",
        description = "Three grants from the system: one to hear you, one to draw the button, one to type for you.",
        nav = nav
    ) {
        PermissionList()

        // The accessibility node route cannot type into apps that take keyboard input through a
        // custom view but expose no editable field — terminals above all. The Android 13+
        // input-method connection can; it is opt-in because it is newer and app-specific.
        if (Build.VERSION.SDK_INT >= 33) {
            SectionGap()
            Group(
                "Experimental",
                description = "For apps the accessibility service cannot type into directly.",
                rows = true
            ) {
                ToggleRow(
                    title = "Keyboard support",
                    description = "Also type through Android's accessibility keyboard connection, so dictation lands in " +
                        "terminals and other apps that show a keyboard but expose no text field to the service. If you just " +
                        "updated Murmur, turn its accessibility service off and on once so this takes effect.",
                    checked = settings.experimentalKeyboard,
                    onCheckedChange = { on -> store.update { it.copy(experimentalKeyboard = on) } }
                )
            }
        }
    }
}

/** The permission rows, shared by the settings screen and onboarding. */
@Composable
fun PermissionList() {
    val context = LocalContext.current
    val permissions = rememberPermissionState()
    var micGranted by remember(permissions.microphone) { mutableStateOf(permissions.microphone) }

    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { micGranted = it }
    val notificationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    if (Build.VERSION.SDK_INT >= 33) {
        LaunchedEffect(Unit) { notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
    }

    // The three grants in one card, set apart by rhythm.
    Card(padding = RowCardPadding) {
        PermissionRow(
            title = "Microphone",
            description = "Recorded only while the button is listening.",
            granted = micGranted,
            onGrant = { micLauncher.launch(Manifest.permission.RECORD_AUDIO) }
        )
        PermissionRow(
            title = "Display over other apps",
            description = "Lets the dictation button float beside any keyboard.",
            granted = permissions.overlay,
            onGrant = {
                context.startActivity(
                    Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
                )
            }
        )
        PermissionRow(
            title = "Accessibility service",
            description = "Inserts the finished text into the field you are typing in. Murmur reads nothing else on screen.",
            granted = permissions.accessibility,
            onGrant = { context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        )
    }
}

@Composable
private fun PermissionRow(title: String, description: String, granted: Boolean, onGrant: () -> Unit) {
    ControlRow(title, description) {
        if (granted) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Dot(Murmur.colors.sage, size = 6.dp)
                Spacer(Modifier.width(8.dp))
                Text("Allowed", style = Murmur.type.labelSmall, color = Murmur.colors.sage)
            }
        } else {
            SecondaryButton("Allow", onClick = onGrant, compact = true)
        }
    }
}
