package app.murmur.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.filterToOne
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onChildren
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.RecordingStore
import app.murmur.android.inference.InferenceRouting
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.Tone
import app.murmur.android.ui.AppearanceScreen
import app.murmur.android.ui.DictionaryScreen
import app.murmur.android.ui.HistoryScreen
import app.murmur.android.ui.InferenceView
import app.murmur.android.ui.LocalInferenceView
import app.murmur.android.ui.SpeechModelScreen
import app.murmur.android.ui.StyleScreen
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.theme.MurmurTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.io.FileOutputStream

/**
 * The settings rows the phone gained for parity with the desktop, on the screens that mirror the
 * desktop's placement: the transcription timeout and the dictionary bias under Speech model →
 * Recognition, the formatting timeout and per-app rules on Style, the session length limit beside
 * Keep recordings on History, snippets on Dictionary and the latency switch on Appearance. Each
 * row reads the store and writes it back, and the number inputs clamp into the shared bounds.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ParitySettingsScreensTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private lateinit var context: Context
    private lateinit var store: SettingsStore
    private var focus: FocusManager? = null

    /** A local build: the user's own provider, no account. */
    private val localView = InferenceView(
        cloudEnabled = false, managedAvailable = false,
        routing = InferenceRouting(InferenceSource.CUSTOM, InferenceSource.CUSTOM),
        signedIn = false, status = null, plan = "free", planState = "free", trialDaysLeft = 0,
        sttReady = true, llmReady = true
    )

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        store = SettingsStore(context)
    }

    private fun show(content: @Composable () -> Unit) {
        compose.setContent {
            val settings by store.flow.collectAsState()
            focus = LocalFocusManager.current
            CompositionLocalProvider(LocalInferenceView provides localView) {
                MurmurTheme(settings.copy(dynamicColor = false)) { content() }
            }
        }
        compose.waitForIdle()
    }

    /** Type a number into a seconds control and move focus away, as a person would. */
    private fun enterSeconds(label: String, value: String) {
        compose.onNodeWithContentDescription(label).performScrollTo().performClick()
        compose.onNodeWithContentDescription(label).performTextClearance()
        compose.onNodeWithContentDescription(label).performTextInput(value)
        compose.runOnIdle { focus?.clearFocus(force = true) }
        compose.waitForIdle()
    }

    /**
     * The screen as rendered, written under build/reports/pill-screenshots/parity like the pill
     * screenshot tests do, so the placement of every row can be seen next to the desktop's.
     */
    private fun snap(name: String) {
        val dir = System.getProperty("murmur.screenshotDir")?.takeIf { it.isNotBlank() }?.let { File(it, "parity") } ?: return
        dir.mkdirs()
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { view.draw(Canvas(bitmap)) }
        FileOutputStream(File(dir, "$name.png")).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** The editable field showing [placeholder] (the placeholder text itself is a separate node). */
    private fun field(placeholder: String) = compose.onNode(hasSetTextAction() and hasText(placeholder))

    /** A chip by label inside one of the rule editor's tagged rows. */
    private fun ruleChip(row: String, label: String) =
        compose.onNodeWithTag(row).onChildren().filterToOne(hasText(label))

    @Test
    fun `Speech model has Recognition with the dictionary bias and the transcription timeout`() {
        store.update { it.copy(sttBaseUrl = "https://api.groq.com/openai/v1", sttModel = "whisper-large-v3-turbo") }
        show {
            val settings by store.flow.collectAsState()
            SpeechModelScreen(store, settings, TopNav.Back {})
        }
        compose.onNodeWithText("RECOGNITION").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Transcription timeout in seconds").performScrollTo()
        snap("android-speech-model-recognition")
        compose.onNodeWithText("Bias with dictionary").performScrollTo().assertIsOn().performClick()
        assertFalse(store.get().useDictionaryPrompt)
        compose.onNodeWithText("Bias with dictionary").assertIsOff()

        // 45 s by default; 30 applies as typed, 121 settles on the ceiling when the field is left.
        compose.onNodeWithText("Timeout").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Transcription timeout in seconds").assertIsDisplayed()
        enterSeconds("Transcription timeout in seconds", "30")
        assertEquals(30_000, store.get().sttTimeoutMs)
        enterSeconds("Transcription timeout in seconds", "121")
        assertEquals(120_000, store.get().sttTimeoutMs)
        enterSeconds("Transcription timeout in seconds", "1")
        assertEquals(2_000, store.get().sttTimeoutMs)
    }

    @Test
    fun `Speech model offers the desktop's provider presets and one fills the connection`() {
        show {
            val settings by store.flow.collectAsState()
            SpeechModelScreen(store, settings, TopNav.Back {})
        }
        compose.onNodeWithText("Groq").performScrollTo().performClick()
        snap("android-speech-model-presets")
        val s = store.get()
        assertEquals("groq", s.sttPresetId)
        assertEquals("https://api.groq.com/openai/v1", s.sttBaseUrl)
        assertEquals("whisper-large-v3-turbo", s.sttModel)
        // A server typed by hand makes the connection Custom again.
        compose.onNodeWithText("https://api.groq.com/openai/v1").performScrollTo().performTextReplacement("http://10.0.0.5:8080/v1")
        compose.waitForIdle()
        assertEquals("custom", store.get().sttPresetId)
        assertEquals("http://10.0.0.5:8080/v1", store.get().sttBaseUrl)
    }

    @Test
    fun `Style has the formatting timeout beside the model and a per-app rules editor`() {
        store.update { it.copy(formattingMode = FormattingMode.SMART, sttBaseUrl = "https://api.groq.com/openai/v1", llmModel = "openai/gpt-oss-20b") }
        show {
            val settings by store.flow.collectAsState()
            StyleScreen(store, settings, TopNav.Back {})
        }
        compose.onNodeWithContentDescription("Formatting timeout in seconds").performScrollTo().assertIsDisplayed()
        snap("android-style-formatting-timeout")
        enterSeconds("Formatting timeout in seconds", "12")
        assertEquals(12_000, store.get().llmTimeoutMs)
        enterSeconds("Formatting timeout in seconds", "99")
        assertEquals(60_000, store.get().llmTimeoutMs)

        compose.onNodeWithText("PER-APP RULES").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Add rule").performScrollTo().performClick()
        assertEquals(1, store.get().appRules.size)
        field("whatsapp, gmail, termux…").performScrollTo().performTextInput("whatsapp")
        ruleChip("rule-tone", "Professional").performScrollTo().performClick()
        ruleChip("rule-mode", "Off").performScrollTo().performClick()
        ruleChip("rule-trailing", "Default").assertIsSelected()
        compose.onNodeWithText("PER-APP RULES").performScrollTo()
        snap("android-style-per-app-rules")
        val rule = store.get().appRules.single()
        assertEquals("whatsapp", rule.match)
        assertEquals(Tone.PROFESSIONAL, rule.tone)
        assertEquals(FormattingMode.OFF, rule.formatting)
        assertNull("trailing space left on Default", rule.trailingSpace)
        compose.onNodeWithText("Remove").performScrollTo().performClick()
        assertTrue(store.get().appRules.isEmpty())
    }

    @Test
    fun `History keeps the session length limit next to Keep recordings, off by default`() {
        val history = HistoryStore.get(context)
        val recordings = RecordingStore.get(context)
        show { HistoryScreen(history, store, recordings, TopNav.Back {}) }
        compose.onNodeWithText("Keep recordings").assertIsDisplayed().assertIsOn()
        compose.onNodeWithText("Limit session length").assertIsDisplayed().assertIsOff()
        compose.onNodeWithText("Unused until you enable the limit above. Dictations run until you stop them.").assertIsDisplayed()
        assertNull(store.get().sessionDurationLimitSec)

        snap("android-history-session-limit-off")
        compose.onNodeWithText("Limit session length").performClick()
        assertTrue(store.get().limitDuration)
        assertEquals(300, store.get().sessionDurationLimitSec)
        compose.onNodeWithText("Dictations stop automatically after this.").assertIsDisplayed()
        snap("android-history-session-limit-on")
        enterSeconds("Maximum dictation length in seconds", "90")
        assertEquals(90, store.get().maxDurationSec)
        enterSeconds("Maximum dictation length in seconds", "4")
        assertEquals(5, store.get().maxDurationSec)
        enterSeconds("Maximum dictation length in seconds", "5000")
        assertEquals(1800, store.get().maxDurationSec)
    }

    @Test
    fun `Dictionary carries the snippets, with the desktop's duplicate rule`() {
        show { DictionaryScreen(store, synced = false, TopNav.Back {}) }
        compose.onNodeWithText("SNIPPETS").performScrollTo().assertIsDisplayed()
        field("my email").performScrollTo().performTextInput("my email")
        field("ben@example.com").performScrollTo().performTextInput("ben@example.com")
        compose.onNodeWithText("Add snippet").performScrollTo().performClick()
        val snippet = store.get().snippets.single()
        assertEquals("my email", snippet.trigger)
        assertEquals("ben@example.com", snippet.content)
        compose.onNodeWithText("“my email”").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("SNIPPETS").performScrollTo()
        snap("android-dictionary-snippets")

        // The same trigger again, in any case, is refused.
        field("my email").performScrollTo().performTextInput("My Email")
        field("ben@example.com").performScrollTo().performTextInput("other")
        compose.onNodeWithText("Add snippet").performScrollTo().performClick()
        assertEquals(1, store.get().snippets.size)
        compose.onNodeWithText("“My Email” is already a snippet trigger").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun `Appearance holds the latency switch, on by default`() {
        show {
            val settings by store.flow.collectAsState()
            AppearanceScreen(store, settings, TopNav.Back {})
        }
        compose.onNodeWithText("Show latency in history").performScrollTo().assertIsOn()
        snap("android-appearance-latency")
        compose.onNodeWithText("Show latency in history").performClick()
        assertFalse(store.get().showLatencyInHistory)
        compose.onNodeWithText("Show latency in history").assertIsOff()
        // The line that points to the Dictation button screen still closes the screen.
        compose.onNodeWithText("Shape and shadow for the button itself are under Dictation button.").performScrollTo().assertIsDisplayed()
    }
}
