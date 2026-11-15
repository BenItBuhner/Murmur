package app.murmur.android.ui

import android.content.ComponentName
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.murmur.android.context.ContextCapture
import app.murmur.android.context.ContextNotificationListener
import app.murmur.android.service.MurmurAccessibilityService
import app.murmur.android.ui.components.ListCard
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.ToggleRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Turns on all-day context for Ephemeris: the text on screen, notifications and the app in front. */
@Composable
fun ContextScreen(nav: TopNav) {
    val context = LocalContext.current
    ContextCapture.init(context)
    val enabled by ContextCapture.enabled.collectAsState()
    val count by ContextCapture.count.collectAsState()
    var endpoint by remember { mutableStateOf(ContextCapture.endpoint) }
    var notice by remember { mutableStateOf<Pair<String, NoticeTone>?>(null) }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val a11y = MurmurAccessibilityService.instance != null
    val listening = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
        ?.contains(ComponentName(context, ContextNotificationListener::class.java).flattenToString()) == true
    Screen(
        title = "Context for Ephemeris",
        description = "${app.murmur.android.Brand.name} can keep what was on your screen and in your notifications, as text, so Ephemeris can find it next to what you said. It never records the screen, so Android shows no recording icon. Password managers, banking and the lock screen are skipped.",
        nav = nav
    ) {
        ListCard {
            ToggleRow(
                title = "Capture context all day",
                description = "$count waiting on this phone",
                checked = enabled,
                onCheckedChange = { ContextCapture.setEnabled(context, it) }
            )
        }
        Spacer(Modifier.height(12.dp))
        if (!a11y) Notice("Turn on ${app.murmur.android.Brand.name}'s accessibility service to read the screen.", NoticeTone.ERROR)
        else Notice("Screen reading is on.", NoticeTone.SUCCESS)
        Spacer(Modifier.height(8.dp))
        if (!listening) {
            Notice("Allow notification access to keep notifications.")
            SecondaryButton("Allow notification access", onClick = {
                context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            })
        } else Notice("Notifications are kept.", NoticeTone.SUCCESS)
        Spacer(Modifier.height(16.dp))
        if (app.murmur.android.Brand.isEphemeris) {
            // The Ephemeris build sends to the account's Ephemeris workspace by itself, every few minutes.
            val last by app.murmur.android.cloud.EphemerisCloud.last.collectAsState()
            Notice("Context goes to your Ephemeris account every few minutes while you're signed in.")
            Spacer(Modifier.height(8.dp))
            SecondaryButton("Send now", loading = sending, onClick = {
                sending = true
                scope.launch {
                    val r = app.murmur.android.cloud.EphemerisCloud.sync(context)
                    notice = r.fold({ "Sent $it records." to NoticeTone.SUCCESS }, { (it.message ?: "Could not send.") to NoticeTone.ERROR })
                    sending = false
                }
            })
            (notice ?: last?.let { it to NoticeTone.NEUTRAL })?.let { (t, tone) -> Spacer(Modifier.height(8.dp)); Notice(t, tone) }
        } else Column {
            OutlinedTextField(
                value = endpoint,
                onValueChange = { endpoint = it; ContextCapture.endpoint = it },
                label = { Text("Ephemeris address") },
                placeholder = { Text("http://192.168.1.20:4747") },
                singleLine = true
            )
            Spacer(Modifier.height(8.dp))
            SecondaryButton("Send to Ephemeris now", loading = sending, onClick = {
                sending = true
                scope.launch {
                    val r = withContext(Dispatchers.IO) { ContextCapture.upload(context) }
                    notice = r.fold({ "Sent $it records." to NoticeTone.SUCCESS }, { (it.message ?: "Could not send.") to NoticeTone.ERROR })
                    sending = false
                }
            })
            notice?.let { (t, tone) -> Spacer(Modifier.height(8.dp)); Notice(t, tone) }
        }
    }
}
