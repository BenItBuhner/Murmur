package app.murmur.android.ui

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.murmur.android.cloud.AccountMode
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.SyncPhase
import app.murmur.android.settings.DictionaryCodec
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.Tone
import com.clerk.api.Clerk
import com.clerk.ui.auth.AuthView
import kotlinx.coroutines.launch

val Accent = Color(0xFFFF5A36)
private val Muted = Color(0xFF9A9AA2)
private val Success = Color(0xFF7EE2A8)

/**
 * The front door of a cloud build: Clerk's prebuilt sign-in/sign-up. Nobody reaches onboarding
 * without an account unless the build is in `optional` mode.
 */
@Composable
fun AccountGateScreen(config: CloudConfig, onSkip: () -> Unit) {
    val ready by Clerk.isInitialized.collectAsState()
    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Murmur", fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Text("Speak. It types.", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "Tap the pill above your keyboard, speak, and clean text lands in the focused field. " +
                "Your account keeps one dictionary and one set of style rules across your phone and your desktop.",
            color = Muted,
            fontSize = 13.sp
        )
        for (line in listOf(
            "One dictionary for every device you sign in on",
            "Style and tone preferences follow you",
            "Speech-model API keys never leave this device"
        )) {
            Text("✓  $line", fontSize = 13.sp, color = Success)
        }
        Spacer(Modifier.height(4.dp))
        if (!ready) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator(Modifier.height(20.dp), strokeWidth = 2.dp)
                Text("Connecting to Murmur…", color = Muted, fontSize = 13.sp)
            }
        } else {
            AuthView()
        }
        if (config.accountMode == AccountMode.OPTIONAL) {
            TextButton(onClick = onSkip, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                Text("Continue without an account")
            }
            Text(
                "Everything stays on this phone. You can sign in later from the Account section.",
                color = Muted, fontSize = 12.sp, modifier = Modifier.align(Alignment.CenterHorizontally)
            )
        }
    }
}

/**
 * First-run flow. The Personalize step is account-level (stored on the account, skipped on the next
 * device); permissions and the speech model are device-level and repeat on every install.
 */
@Composable
fun OnboardingScreen(
    store: SettingsStore,
    signedIn: Boolean,
    accountOnboarded: Boolean,
    firstName: String?,
    permissions: @Composable () -> Unit,
    provider: @Composable () -> Unit,
    onFinish: () -> Unit
) {
    val settings by store.flow.collectAsState()
    val steps = remember(signedIn, accountOnboarded) {
        buildList {
            add("welcome")
            if (signedIn && !accountOnboarded) add("personalize")
            add("permissions")
            add("provider")
        }
    }
    var index by remember { mutableStateOf(0) }
    val step = steps[index]
    val returning = signedIn && accountOnboarded

    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            steps.forEachIndexed { i, _ ->
                Card(
                    colors = CardDefaults.cardColors(containerColor = if (i <= index) Accent else Color(0xFF2A2A30)),
                    shape = RoundedCornerShape(3.dp),
                    modifier = Modifier.weight(1f).height(4.dp)
                ) {}
            }
        }
        when (step) {
            "welcome" -> {
                Text(
                    if (returning) "Welcome back${firstName?.let { ", $it" } ?: ""}." else "Speak. It types.",
                    fontSize = 26.sp, fontWeight = FontWeight.Bold
                )
                Text(
                    if (returning)
                        "Your account is already set up: ${settings.dictionaryEntries.size} dictionary " +
                            "${if (settings.dictionaryEntries.size == 1) "word" else "words"} and your style are on this phone now. " +
                            "Two quick device steps and you are dictating."
                    else
                        "Tap the pill above your keyboard, speak, and clean text lands in the focused field. " +
                            "Murmur cleans up the ums and self-corrections and drops finished text where your cursor is.",
                    color = Muted, fontSize = 14.sp
                )
                if (signedIn && !returning) {
                    Text("✓  Your dictionary syncs to every device you sign in on", fontSize = 13.sp, color = Success)
                    Text("✓  API keys stay on this phone; only your words and settings sync", fontSize = 13.sp, color = Success)
                }
            }
            "personalize" -> PersonalizeStep(store, firstName)
            "permissions" -> {
                Text("Permissions", fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text(
                    "The pill needs to draw over other apps and the accessibility service inserts text into the field you are typing in.",
                    color = Muted, fontSize = 13.sp
                )
                permissions()
            }
            "provider" -> {
                Text("Speech model", fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text(
                    "Murmur sends recordings to a transcription API you control. Keys stay on this phone.",
                    color = Muted, fontSize = 13.sp
                )
                provider()
            }
        }
        Spacer(Modifier.weight(1f))
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            TextButton(onClick = { if (index > 0) index-- }, enabled = index > 0) { Text("Back") }
            if (index == steps.lastIndex) {
                Button(onClick = onFinish, colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text("Finish") }
            } else {
                Button(onClick = { index++ }, colors = ButtonDefaults.buttonColors(containerColor = Accent)) {
                    Text(if (index == 0) "Get started" else "Continue")
                }
            }
        }
    }
}

@Composable
private fun PersonalizeStep(store: SettingsStore, firstName: String?) {
    val settings by store.flow.collectAsState()
    var terms by remember { mutableStateOf("") }
    Text("Make it yours${firstName?.let { ", $it" } ?: ""}", fontSize = 22.sp, fontWeight = FontWeight.Bold)
    Text(
        "These choices live in your account, so every device you sign in on picks them up. You only do this once.",
        color = Muted, fontSize = 13.sp
    )
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(14.dp)
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Names, products and tools you say often", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Text(
                "Speech models misspell names. Anything in your dictionary is spelled the way you wrote it.",
                color = Muted, fontSize = 12.sp
            )
            OutlinedTextField(
                value = terms,
                onValueChange = { terms = it },
                label = { Text("Comma-separated") },
                placeholder = { Text("Wispr Flow, Kubernetes, Priya", color = Color(0xFF6A6A72)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                colors = fieldColors()
            )
            OutlinedButton(
                onClick = {
                    addWords(store, terms)
                    terms = ""
                },
                enabled = terms.isNotBlank()
            ) { Text("Add") }
            if (settings.dictionaryEntries.isNotEmpty()) {
                Text(settings.dictionaryEntries.take(12).joinToString(", ") { it.word }, fontSize = 12.sp, color = Muted)
            }
        }
    }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(14.dp)
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Default tone", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Text("Auto reads the app you are typing in: casual in chat, professional in email.", color = Muted, fontSize = 12.sp)
            Row {
                for (tone in Tone.entries) {
                    FilterChip(
                        selected = settings.tone == tone,
                        onClick = { store.update { s -> s.copy(tone = tone) } },
                        label = { Text(tone.id) },
                        modifier = Modifier.padding(end = 6.dp)
                    )
                }
            }
        }
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

/** Structured dictionary editor (replaces the old comma-separated field). */
@Composable
fun DictionaryEditor(store: SettingsStore, synced: Boolean) {
    val settings by store.flow.collectAsState()
    var word by remember { mutableStateOf("") }
    var aliases by remember { mutableStateOf("") }
    Text(
        if (synced) "Saved to your account and shared with every device you sign in on."
        else "Names and jargon the transcriber should get right. Used as a hint for the speech model and enforced in the text.",
        color = Muted, fontSize = 12.sp
    )
    OutlinedTextField(
        value = word, onValueChange = { word = it }, label = { Text("Word or phrase") },
        placeholder = { Text("e.g. Wispr Flow", color = Color(0xFF6A6A72)) },
        singleLine = true, modifier = Modifier.fillMaxWidth(), colors = fieldColors()
    )
    OutlinedTextField(
        value = aliases, onValueChange = { aliases = it }, label = { Text("Sounds like (optional, comma-separated)") },
        placeholder = { Text("whisper flow, wisper flow", color = Color(0xFF6A6A72)) },
        singleLine = true, modifier = Modifier.fillMaxWidth(), colors = fieldColors()
    )
    OutlinedButton(
        onClick = {
            val w = word.trim()
            if (w.isNotEmpty() && store.get().dictionaryEntries.none { it.word.equals(w, ignoreCase = true) }) {
                val entry = DictionaryCodec.newEntry(w, aliases.split(',').map { it.trim() }, fuzzy = false)
                store.update { s -> s.copy(dictionaryEntries = listOf(entry) + s.dictionaryEntries) }
            }
            word = ""
            aliases = ""
        },
        enabled = word.isNotBlank()
    ) { Text("Add word") }
    for (entry in settings.dictionaryEntries) {
        DictionaryRow(entry, onRemove = {
            store.update { s -> s.copy(dictionaryEntries = s.dictionaryEntries.filter { it.id != entry.id }) }
        })
    }
}

@Composable
private fun DictionaryRow(entry: DictionaryEntry, onRemove: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(entry.word, fontSize = 14.sp)
            if (entry.aliases.isNotEmpty()) Text(entry.aliases.joinToString(", "), fontSize = 11.sp, color = Muted)
        }
        TextButton(onClick = onRemove) { Text("Remove", color = Muted) }
    }
}

/** Account card for the settings screen (cloud builds only). */
@Composable
fun AccountSection(config: CloudConfig, store: SettingsStore, onSignIn: () -> Unit) {
    val sync = CloudSync.get()
    val status by (sync?.status ?: return).collectAsState()
    val user by Clerk.userFlow.collectAsState()
    val scope = rememberCoroutineScope()
    if (user == null) {
        Text("You are using Murmur without an account.", fontSize = 14.sp)
        Text(
            "Sign in to sync your dictionary and style to your other devices. Your local words are merged into the account the first time you sign in.",
            color = Muted, fontSize = 12.sp
        )
        Button(onClick = onSignIn, colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text("Sign in or create account") }
        return
    }
    val name = status.user?.name ?: listOfNotNull(user?.firstName, user?.lastName).joinToString(" ").ifBlank { "Your account" }
    val email = status.user?.email ?: user?.primaryEmailAddress?.emailAddress
    Text(name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    if (email != null) Text(email, fontSize = 12.sp, color = Muted)
    val label = when (status.phase) {
        SyncPhase.SYNCED -> "Synced"
        SyncPhase.SYNCING -> "Syncing ${status.pendingOps}…"
        SyncPhase.CONNECTING -> "Connecting…"
        SyncPhase.OFFLINE -> "Offline (${status.pendingOps} pending)"
        SyncPhase.ERROR -> "Sync issue: ${status.error ?: "retrying"}"
        SyncPhase.SIGNED_OUT -> "Signed out"
        SyncPhase.DISABLED -> "Local"
    }
    Text(label, fontSize = 13.sp, color = if (status.phase == SyncPhase.SYNCED) Success else Muted)
    Text(
        "Dictionary and style preferences sync; API keys stay on this phone. ${status.devices.size} " +
            "${if (status.devices.size == 1) "device" else "devices"} on this account.",
        fontSize = 12.sp, color = Muted
    )
    Text("Instance: ${config.convexUrl}", fontSize = 11.sp, color = Muted)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { sync.syncNow() }) { Text("Sync now") }
        OutlinedButton(onClick = { scope.launch { sync.signOut() } }) { Text("Sign out") }
    }
    val settings by store.flow.collectAsState()
    Spacer(Modifier.height(2.dp))
    Text("${settings.dictionaryEntries.size} dictionary words on this account", fontSize = 12.sp, color = Muted)
}

@Composable
fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Accent,
    unfocusedBorderColor = Color(0xFF2A2A30),
    focusedLabelColor = Accent,
    unfocusedLabelColor = Muted,
    cursorColor = Accent
)
