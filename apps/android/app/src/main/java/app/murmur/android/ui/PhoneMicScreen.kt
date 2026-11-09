package app.murmur.android.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.murmur.android.cloud.CloudBoot
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.phonemic.DictationState
import app.murmur.android.phonemic.LinkPhase
import app.murmur.android.phonemic.MicReceiverDto
import app.murmur.android.phonemic.PhoneMic
import app.murmur.android.ui.components.ListCard
import app.murmur.android.ui.components.ListRow
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.ToggleRow
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.PrimaryButton
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.TextLink
import app.murmur.android.ui.components.Well
import app.murmur.android.ui.theme.Murmur
import kotlinx.coroutines.delay

/** "12:04", "1:02:09": the length of the running dictation. */
fun clockLabel(seconds: Long): String {
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/**
 * Phone as microphone (docs/phone-microphone.md): this phone becomes the microphone of a computer
 * signed in to the same account. The voice goes straight to the computer over the network; start
 * and stop here, and the text lands at the cursor there.
 */
@Composable
fun PhoneMicScreen(config: CloudConfig, cloud: CloudBoot, signedIn: Boolean, nav: TopNav) {
    val context = LocalContext.current
    val state by PhoneMic.state.collectAsState()
    var micAllowed by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        )
    }
    var pending by remember { mutableStateOf<MicReceiverDto?>(null) }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        micAllowed = granted
        val target = pending
        pending = null
        if (granted && target != null) PhoneMic.connect(context, target)
    }
    val connect = { r: MicReceiverDto ->
        if (micAllowed) PhoneMic.connect(context, r)
        else {
            pending = r
            askMic.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    Screen(
        title = "Phone microphone",
        description = "Talk into this phone anywhere in the room and the text lands at the cursor on your computer. Your voice goes straight to the computer, not through Murmur's servers.",
        nav = nav
    ) {
        when {
            !config.enabled || cloud !is CloudBoot.Ready ->
                Notice("This needs a Murmur account, which this build does not use.")
            !signedIn ->
                Notice("Sign in on the Account page with the account your computer uses.")
            state.desktop != null && state.phase != null -> Linked(state.desktop!!.name, connect)
            else -> Choose(connect)
        }
        if (config.enabled && cloud is CloudBoot.Ready && signedIn) {
            Spacer(Modifier.height(24.dp))
            var allDay by remember { mutableStateOf(app.murmur.android.allday.AllDay.enabled(context)) }
            val askForAllDay = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
                micAllowed = granted
                if (granted) { app.murmur.android.allday.AllDay.setEnabled(context, true); allDay = true }
            }
            ToggleRow(
                title = "Record all day",
                checked = allDay,
                onCheckedChange = { on ->
                    if (on && !micAllowed) askForAllDay.launch(Manifest.permission.RECORD_AUDIO)
                    else { app.murmur.android.allday.AllDay.setEnabled(context, on); allDay = on }
                },
                description = "Keeps listening in the background. Silence is skipped; speech goes to your account, where it is transcribed for Ephemeris on your computer, from any network. Audio is not kept on the phone."
            )
        }
    }
}

@Composable
private fun Choose(connect: (MicReceiverDto) -> Unit) {
    val state by PhoneMic.state.collectAsState()
    val c = Murmur.colors
    LaunchedEffect(Unit) { PhoneMic.refresh() }
    Text("Pick a computer", style = Murmur.type.headline, color = c.ink)
    Spacer(Modifier.height(6.dp))
    Text(
        "Computers signed in to this account with Phone as microphone turned on, in Murmur's Microphone settings.",
        style = Murmur.type.bodySmall,
        color = c.inkSoft
    )
    Spacer(Modifier.height(16.dp))
    val receivers = state.receivers
    when {
        state.loadError != null -> Notice(state.loadError!!, NoticeTone.ERROR)
        receivers == null -> Notice("Looking for your computers…")
        receivers.isEmpty() -> Well {
            Text(
                "None yet. On your computer, open Murmur, go to Microphone and turn on Use a phone as the microphone, then refresh.",
                style = Murmur.type.body,
                color = c.inkSoft
            )
        }
        else -> ListCard {
            for (r in receivers) {
                ListRow(onClick = { connect(r) }) {
                    Column(Modifier.weight(1f)) {
                        Text(r.name, style = Murmur.type.title, color = c.ink)
                        Text(platformLabel(r.platform), style = Murmur.type.bodySmall, color = c.inkSoft)
                    }
                    Text("Connect", style = Murmur.type.label, color = c.emberText)
                }
            }
        }
    }
    state.detail?.let {
        Spacer(Modifier.height(12.dp))
        Notice(it, NoticeTone.ERROR)
    }
    Spacer(Modifier.height(16.dp))
    TextLink(if (state.loading) "Refreshing…" else "Refresh", onClick = { PhoneMic.refresh() })
}

@Composable
private fun Linked(desktop: String, connect: (MicReceiverDto) -> Unit) {
    val context = LocalContext.current
    val state by PhoneMic.state.collectAsState()
    val c = Murmur.colors
    val listening = state.dictation == DictationState.LISTENING
    val processing = state.dictation == DictationState.PROCESSING
    val linked = state.phase == LinkPhase.LINKED
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(listening) {
        while (listening) {
            now = SystemClock.elapsedRealtime()
            delay(500)
        }
    }
    val elapsed = state.listeningSince?.let { ((now - it) / 1000).coerceAtLeast(0) } ?: 0

    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Microphone for", style = Murmur.type.bodySmall, color = c.inkSoft)
        Text(desktop, style = Murmur.type.displaySmall, color = c.ink, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(
            when (state.phase) {
                LinkPhase.CONNECTING -> "Connecting…"
                LinkPhase.LINKED -> "Connected. The text lands where the cursor is on the computer."
                LinkPhase.INTERRUPTED -> "Connection interrupted. Reconnecting…"
                LinkPhase.CLOSED, null -> state.detail ?: "Disconnected."
            },
            style = Murmur.type.bodySmall,
            color = if (state.phase == LinkPhase.CLOSED) c.clay else c.inkSoft,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(28.dp))

        if (state.phase == LinkPhase.CLOSED) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PrimaryButton("Reconnect", onClick = { state.desktop?.let(connect) })
                SecondaryButton("Choose another", onClick = { PhoneMic.disconnect(context) })
            }
        } else {
            Box(contentAlignment = Alignment.Center) {
                if (listening) {
                    Box(
                        Modifier
                            .size(184.dp)
                            .scale(1f + state.level * 0.22f)
                            .clip(CircleShape)
                            .background(c.ember.copy(alpha = 0.22f))
                    )
                }
                val enabled = linked && !processing
                Box(
                    Modifier
                        .size(184.dp)
                        .clip(CircleShape)
                        .background(if (listening) c.ember else c.paperRaised)
                        .clickable(enabled = enabled, role = Role.Button) {
                            PhoneMic.send(if (listening) "stop" else "start")
                        },
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            when {
                                listening -> "Stop"
                                processing -> "Writing…"
                                else -> "Start"
                            },
                            style = Murmur.type.headline,
                            color = when {
                                listening -> c.onEmber
                                enabled -> c.ink
                                else -> c.inkMuted
                            }
                        )
                        if (listening) Text(clockLabel(elapsed), style = Murmur.type.label, color = c.onEmber)
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                if (listening) TextLink("Discard", onClick = { PhoneMic.send("cancel") })
                TextLink("Disconnect", onClick = { PhoneMic.disconnect(context) })
            }
        }

        state.error?.let {
            Spacer(Modifier.height(16.dp))
            Notice(it, NoticeTone.ERROR)
        }
        state.result?.let { r ->
            Spacer(Modifier.height(20.dp))
            Well(Modifier.fillMaxWidth()) {
                Text(
                    "Inserted ${r.words} word${if (r.words == 1) "" else "s"}",
                    style = Murmur.type.labelSmall,
                    color = c.inkSoft
                )
                Spacer(Modifier.height(4.dp))
                Text(r.text, style = Murmur.type.body, color = c.ink, maxLines = 5)
            }
        }
        Spacer(Modifier.height(20.dp))
        Text(
            "You can turn the screen off; the link stays up while Murmur shows its microphone notification.",
            style = Murmur.type.bodySmall,
            color = c.inkMuted,
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.width(1.dp))
    }
}

private fun platformLabel(platform: String): String = when (platform) {
    "win32" -> "Windows"
    "darwin" -> "macOS"
    "linux" -> "Linux"
    else -> platform
}
