package app.murmur.android

import android.content.ClipboardManager
import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import app.murmur.android.service.KeyboardTimingLog
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.PermissionsScreen
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.theme.MurmurTheme
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * The keyboard timing log: every line timed on the uptime clock, bounded however long the keyboard
 * stays up, the last few openings and closings kept, and handed over from the Permissions screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
class KeyboardTimingLogTest {

    @get:Rule
    val compose = createComposeRule()

    private val context: Context get() = RuntimeEnvironment.getApplication()

    @Before
    fun setUp() = KeyboardTimingLog.clear()

    @After
    fun tearDown() = KeyboardTimingLog.clear()

    @Test
    fun `each line carries its uptime and the time since the line before`() {
        KeyboardTimingLog.record(1000, "ev WINDOWS")
        KeyboardTimingLog.record(1016, "win n=5")
        val lines = KeyboardTimingLog.text().lines()
        assertTrue(lines.toString(), "1000 +0 ev WINDOWS" in lines)
        assertTrue(lines.toString(), "1016 +16 win n=5" in lines)
    }

    @Test
    fun `a keyboard left up for a long time keeps the first and last of what happened, and says how much fell between`() {
        KeyboardTimingLog.keyboardChanged(0, up = true)
        repeat(400) { KeyboardTimingLog.record(it.toLong(), "line $it") }
        val lines = KeyboardTimingLog.text().lines().filter { it.isNotEmpty() }
        assertEquals("== keyboard up #1 at 0 ==", lines.first())
        assertEquals("0 +0 line 0", lines[1])
        assertEquals("59 +1 line 59", lines[60])
        assertEquals("... 240 lines dropped ...", lines[61])
        assertEquals("300 +1 line 300", lines[62])
        assertEquals("399 +1 line 399", lines.last())
        assertEquals(1 + 60 + 1 + 100, lines.size)
    }

    @Test
    fun `only the last few openings and closings are kept`() {
        repeat(10) { n ->
            KeyboardTimingLog.keyboardChanged(n * 1000L, up = true)
            KeyboardTimingLog.record(n * 1000L + 1, "kb visible=1")
            KeyboardTimingLog.keyboardChanged(n * 1000L + 500, up = false)
        }
        val titles = KeyboardTimingLog.text().lines().filter { it.startsWith("==") }
        assertEquals(8, titles.size)
        assertEquals("== keyboard up #7 at 6000 ==", titles.first())
        assertEquals("== keyboard gone #10 at 9500 ==", titles.last())
    }

    @Test
    fun `the report starts with the phone, the keyboard and what was learnt about it`() {
        Settings.Secure.putString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD, "com.samsung.android.honeyboard/.service.HoneyBoardService")
        context.getSharedPreferences("keyboard_offsets", Context.MODE_PRIVATE).edit()
            .putFloat("com.samsung.android.honeyboard", 5f).commit()
        KeyboardTimingLog.keyboardChanged(100, up = true)
        KeyboardTimingLog.record(100, "kb visible=1 ready=1")
        val report = KeyboardTimingLog.report(context)
        assertTrue(report, report.startsWith("Murmur keyboard timing log\nMurmur ${BuildConfig.VERSION_NAME} on "))
        assertTrue(report, "keyboard: com.samsung.android.honeyboard/.service.HoneyBoardService" in report)
        assertTrue(report, "resting offsets remembered (dp): com.samsung.android.honeyboard=5.0" in report)
        assertTrue(report, report.trimEnd().endsWith("== keyboard up #1 at 100 ==\n100 +0 kb visible=1 ready=1"))
    }

    @Test
    fun `Permissions has a Diagnostics row that copies the log to the clipboard`() {
        KeyboardTimingLog.record(42, "ev WINDOWS")
        val store = SettingsStore(context)
        compose.setContent {
            val settings by store.flow.collectAsState()
            MurmurTheme(settings.copy(dynamicColor = false)) {
                PermissionsScreen(TopNav.Back {})
            }
        }
        compose.onNodeWithText("DIAGNOSTICS").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Copy keyboard timing log").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Copy").performScrollTo().performClick()
        val clip = context.getSystemService(ClipboardManager::class.java).primaryClip
        val text = clip?.getItemAt(0)?.text?.toString().orEmpty()
        assertTrue(text, text.startsWith("Murmur keyboard timing log"))
        assertTrue(text, "42 +0 ev WINDOWS" in text)
        compose.onNodeWithText("Copied").assertIsDisplayed()
    }
}
