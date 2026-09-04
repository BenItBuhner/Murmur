package app.murmur.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import app.murmur.android.audio.SAMPLE_RATE
import app.murmur.android.audio.Wav
import app.murmur.android.llm.LlmClient
import app.murmur.android.llm.LlmConfig
import app.murmur.android.service.MurmurAccessibilityService
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttKind
import app.murmur.android.settings.Tone
import app.murmur.android.stt.SttClient
import app.murmur.android.stt.SttConfig
import app.murmur.android.stt.SttException
import app.murmur.android.text.AppCategory
import app.murmur.android.text.AppContext
import app.murmur.android.text.buildFormatMessages
import app.murmur.android.text.maxTokensFor
import app.murmur.android.text.runPipeline
import app.murmur.android.text.sanitizeLlmOutput
import app.murmur.android.text.PipelineOptions
import kotlinx.coroutines.launch

private val Accent = Color(0xFFFF5A36)
private val DarkScheme = darkColorScheme(
    primary = Accent,
    background = Color(0xFF0E0E10),
    surface = Color(0xFF17171A),
    surfaceVariant = Color(0xFF1E1E22),
    onBackground = Color(0xFFEDEDEF),
    onSurface = Color(0xFFEDEDEF)
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = DarkScheme) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    SettingsScreen()
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen() {
    val context = LocalContext.current
    val store = remember { SettingsStore.get(context) }
    val settings by store.flow.collectAsState()
    val scope = rememberCoroutineScope()

    var micGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    var overlayGranted by remember { mutableStateOf(Settings.canDrawOverlays(context)) }
    var a11yRunning by remember { mutableStateOf(MurmurAccessibilityService.isRunning) }

    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        micGranted = it
    }
    val notifLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }

    // Refresh permission states when returning from system settings.
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner) {
        lifecycleOwner.lifecycle.addObserver(
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME) {
                    micGranted = ContextCompat.checkSelfPermission(
                        context, Manifest.permission.RECORD_AUDIO
                    ) == PackageManager.PERMISSION_GRANTED
                    overlayGranted = Settings.canDrawOverlays(context)
                    a11yRunning = MurmurAccessibilityService.isRunning
                }
            }
        )
    }

    var models by remember { mutableStateOf<List<String>>(emptyList()) }
    var llmModels by remember { mutableStateOf<List<String>>(emptyList()) }
    var discovering by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<String?>(null) }
    var testing by remember { mutableStateOf(false) }
    var testPad by remember { mutableStateOf("") }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Murmur", fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Text(
            "Tap the pill above your keyboard, speak, and clean text lands in the focused field.",
            color = Color(0xFF9A9AA2),
            fontSize = 13.sp
        )

        SectionCard("Setup") {
            PermissionRow("Microphone", micGranted) {
                micLauncher.launch(Manifest.permission.RECORD_AUDIO)
            }
            PermissionRow("Display over other apps", overlayGranted) {
                context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:${context.packageName}")
                    )
                )
            }
            PermissionRow("Accessibility service", a11yRunning) {
                context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            if (Build.VERSION.SDK_INT >= 33) {
                LaunchedEffect(Unit) {
                    notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }
        }

        SectionCard("Speech to text") {
            LabeledField("Base URL", settings.sttBaseUrl, placeholder = "https://api.groq.com/openai/v1") {
                store.update { s -> s.copy(sttBaseUrl = it) }
            }
            LabeledField("API key", settings.sttApiKey, password = true) {
                store.update { s -> s.copy(sttApiKey = it) }
            }
            LabeledField("Model", settings.sttModel, placeholder = "whisper-large-v3-turbo") {
                store.update { s -> s.copy(sttModel = it) }
            }
            if (models.isNotEmpty()) {
                ModelChips(models.take(8), settings.sttModel) {
                    store.update { s -> s.copy(sttModel = it) }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = {
                        discovering = true
                        scope.launch {
                            try {
                                models = SttClient.listModels(sttConfig(settings))
                            } catch (e: Exception) {
                                testResult = "Model discovery failed: ${friendly(e)}"
                            } finally {
                                discovering = false
                            }
                        }
                    },
                    enabled = !discovering && settings.sttBaseUrl.isNotEmpty()
                ) { Text(if (discovering) "Discovering…" else "Discover models") }
            }
        }

        SectionCard("Smart formatting") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Mode", Modifier.width(90.dp), fontSize = 13.sp, color = Color(0xFF9A9AA2))
                for (mode in FormattingMode.entries) {
                    FilterChip(
                        selected = settings.formattingMode == mode,
                        onClick = { store.update { s -> s.copy(formattingMode = mode) } },
                        label = { Text(mode.id) },
                        modifier = Modifier.padding(end = 6.dp)
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Tone", Modifier.width(90.dp), fontSize = 13.sp, color = Color(0xFF9A9AA2))
                for (tone in Tone.entries) {
                    FilterChip(
                        selected = settings.tone == tone,
                        onClick = { store.update { s -> s.copy(tone = tone) } },
                        label = { Text(tone.id) },
                        modifier = Modifier.padding(end = 6.dp)
                    )
                }
            }
            LabeledField("LLM model", settings.llmModel, placeholder = "llama-3.1-8b-instant") {
                store.update { s -> s.copy(llmModel = it) }
            }
            if (llmModels.isNotEmpty()) {
                ModelChips(llmModels.take(8), settings.llmModel) {
                    store.update { s -> s.copy(llmModel = it) }
                }
            }
            OutlinedButton(
                onClick = {
                    scope.launch {
                        try {
                            val (base, key, _) = settings.llmConnection()
                            llmModels = LlmClient.listModels(base, key)
                        } catch (e: Exception) {
                            testResult = "Model discovery failed: ${friendly(e)}"
                        }
                    }
                },
                enabled = settings.sttBaseUrl.isNotEmpty()
            ) { Text("Discover models") }
            LabeledField("Custom words (comma-separated)", settings.dictionary, placeholder = "Murmur, Wispr") {
                store.update { s -> s.copy(dictionary = it) }
            }
        }

        SectionCard("Try it") {
            Text(
                "Test pad: focus the field and the pill appears above the keyboard.",
                fontSize = 12.sp, color = Color(0xFF9A9AA2)
            )
            OutlinedTextField(
                value = testPad,
                onValueChange = { testPad = it },
                modifier = Modifier.fillMaxWidth().height(120.dp),
                placeholder = { Text("Dictate into me…") },
                colors = fieldColors()
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        testing = true
                        testResult = null
                        scope.launch {
                            testResult = try {
                                runSampleTest(context, settings)
                            } catch (e: Exception) {
                                "Failed: ${friendly(e)}"
                            }
                            testing = false
                        }
                    },
                    enabled = !testing && settings.sttBaseUrl.isNotEmpty(),
                    colors = ButtonDefaults.buttonColors(containerColor = Accent)
                ) { Text(if (testing) "Testing…" else "Test with sample clip") }
                if (testing) CircularProgressIndicator(Modifier.width(20.dp).height(20.dp), strokeWidth = 2.dp)
            }
            testResult?.let {
                Text(it, fontSize = 12.sp, color = Color(0xFFB8E0C2))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Use sample clip instead of microphone", fontSize = 13.sp)
                    Text(
                        "For emulators without a mic: the pill dictates the bundled JFK clip.",
                        fontSize = 11.sp, color = Color(0xFF9A9AA2)
                    )
                }
                Switch(
                    checked = settings.useFixtureAudio,
                    onCheckedChange = { store.update { s -> s.copy(useFixtureAudio = it) } }
                )
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

private fun sttConfig(s: MurmurSettings) = SttConfig(
    kind = s.sttKind,
    baseUrl = s.sttBaseUrl,
    apiKey = s.sttApiKey,
    model = s.sttModel,
    language = s.language,
    timeoutMs = s.sttTimeoutMs
)

private fun friendly(e: Exception): String =
    if (e is SttException) e.friendly() else e.message ?: "Unknown error"

/** Full STT -> pipeline -> LLM round-trip on the bundled fixture, reporting real latencies. */
private suspend fun runSampleTest(context: android.content.Context, s: MurmurSettings): String {
    val bytes = context.assets.open("fixtures/jfk.wav").use { it.readBytes() }
    val (pcm, rate) = Wav.decodePcm16(bytes)
    val wav = Wav.encodePcm16(Wav.resample(pcm, rate, SAMPLE_RATE), SAMPLE_RATE)
    val stt = SttClient.transcribeWithFallback(wav, null, sttConfig(s), s.sttFallbackModel)
    val light = runPipeline(stt.text, PipelineOptions())
    var out = "STT ${stt.latencyMs}ms: ${light.text.trim()}"
    val (base, key, model) = s.llmConnection()
    if (s.formattingMode == FormattingMode.SMART && base.isNotEmpty() && model.isNotEmpty()) {
        val res = LlmClient.chatComplete(
            LlmConfig(base, key, model, s.llmTimeoutMs),
            buildFormatMessages(
                light.text.trim(), s.dictionaryTerms, Tone.NEUTRAL,
                AppContext("test", AppCategory.UNKNOWN)
            ),
            maxTokens = maxTokensFor(light.text)
        )
        val guard = sanitizeLlmOutput(res.text, light.text)
        out += if (guard.ok) "\nLLM ${res.latencyMs}ms: ${guard.text}"
        else "\nLLM output rejected (${guard.reason}), deterministic text kept"
    }
    return out
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(14.dp)
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            content()
        }
    }
}

@Composable
private fun PermissionRow(label: String, granted: Boolean, onGrant: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, fontSize = 14.sp)
        }
        if (granted) {
            Text("Granted", color = Color(0xFF7EE2A8), fontSize = 13.sp)
        } else {
            OutlinedButton(onClick = onGrant) { Text("Grant") }
        }
    }
}

@Composable
private fun LabeledField(
    label: String,
    value: String,
    placeholder: String = "",
    password: Boolean = false,
    onChange: (String) -> Unit
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        placeholder = { Text(placeholder, color = Color(0xFF6A6A72)) },
        singleLine = true,
        visualTransformation = if (password) {
            androidx.compose.ui.text.input.PasswordVisualTransformation()
        } else {
            androidx.compose.ui.text.input.VisualTransformation.None
        },
        modifier = Modifier.fillMaxWidth(),
        colors = fieldColors()
    )
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Accent,
    unfocusedBorderColor = Color(0xFF2A2A30),
    focusedLabelColor = Accent,
    unfocusedLabelColor = Color(0xFF9A9AA2),
    cursorColor = Accent
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelChips(models: List<String>, selected: String, onSelect: (String) -> Unit) {
    Column {
        for (row in models.chunked(2)) {
            Row {
                for (m in row) {
                    FilterChip(
                        selected = m == selected,
                        onClick = { onSelect(m) },
                        label = { Text(m, fontSize = 11.sp, maxLines = 1) },
                        modifier = Modifier.padding(end = 6.dp, bottom = 2.dp)
                    )
                }
            }
        }
    }
}
