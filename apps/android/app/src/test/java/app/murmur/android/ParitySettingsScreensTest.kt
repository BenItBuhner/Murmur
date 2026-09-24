package app.murmur.android

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
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
    val compose = createComposeRule()

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

    @Test
    fun `Speech model has Recognition with the dictionary bias and the transcription timeout`() {
        store.update { it.copy(sttBaseUrl = "https://api.groq.com/openai/v1", sttModel = "whisper-large-v3-turbo") }
        show {
            val settings by store.flow.collectAsState()
            SpeechModelScreen(store, settings, TopNav.Back {})
        }
        compose.onNodeWithText("RECOGNITION").performScrollTo().assertIsDisplayed()
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
        enterSeconds("Formatting timeout in seconds", "12")
        assertEquals(12_000, store.get().llmTimeoutMs)
        enterSeconds("Formatting timeout in seconds", "99")
        assertEquals(60_000, store.get().llmTimeoutMs)

        compose.onNodeWithText("PER-APP RULES").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Add rule").performScrollTo().performClick()
        assertEquals(1, store.get().appRules.size)
        compose.onNodeWithText("whatsapp, gmail, termux…").performScrollTo().performTextInput("whatsapp")
        compose.onNodeWithText("Professional").performScrollTo().performClick()
        compose.onNodeWithText("Off").performScrollTo().performClick()
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

        compose.onNodeWithText("Limit session length").performClick()
        assertTrue(store.get().limitDuration)
        assertEquals(300, store.get().sessionDurationLimitSec)
        compose.onNodeWithText("Dictations stop automatically after this.").assertIsDisplayed()
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
        compose.onNodeWithText("my email").performScrollTo().performTextInput("my email")
        compose.onNodeWithText("ben@example.com").performScrollTo().performTextInput("ben@example.com")
        compose.onNodeWithText("Add snippet").performScrollTo().performClick()
        val snippet = store.get().snippets.single()
        assertEquals("my email", snippet.trigger)
        assertEquals("ben@example.com", snippet.content)
        compose.onNodeWithText("“my email”").performScrollTo().assertIsDisplayed()

        // The same trigger again, in any case, is refused.
        compose.onNodeWithText("my email").performScrollTo().performTextInput("My Email")
        compose.onNodeWithText("ben@example.com").performScrollTo().performTextInput("other")
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
        compose.onNodeWithText("Show latency in history").performScrollTo().assertIsOn().performClick()
        assertFalse(store.get().showLatencyInHistory)
        compose.onNodeWithText("Show latency in history").assertIsOff()
        // The line that points to the Dictation button screen still closes the screen.
        compose.onNodeWithText("Shape and shadow for the button itself are under Dictation button.").performScrollTo().assertIsDisplayed()
    }
}
