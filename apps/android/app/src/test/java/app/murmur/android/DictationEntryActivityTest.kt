package app.murmur.android

import android.Manifest
import android.content.Intent
import android.os.Looper
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.dictation.TextSink
import app.murmur.android.entry.DictationEntryActivity
import app.murmur.android.entry.EntryActions
import app.murmur.android.service.MurmurAccessibilityService
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.SettingsStore
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The external-entry trampoline, end to end with the fixture recorder (as DictationFlowTest):
 * a toggle from outside starts and stops the same dictation the pill would, the gates refuse
 * when a door is shut (and take the user where it is fixed), a double-firing trigger is one
 * command, and the lock screen holds the command until the user gets past it.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xxhdpi")
class DictationEntryActivityTest {

    private val context get() = RuntimeEnvironment.getApplication()
    private var service: MurmurAccessibilityService? = null
    private var server: MockWebServer? = null

    @Before
    fun setUp() {
        DictationEntryActivity.resetDebounce()
        if (DictationController.isListening) DictationController.cancel(context)
        DictationController.dismiss()
        MurmurAccessibilityService.frontApp = null
        MurmurAccessibilityService.clearFronts()
        shadowOf(context).grantPermissions(Manifest.permission.RECORD_AUDIO)
        SettingsStore.get(context).update {
            it.copy(onboardingComplete = true, useFixtureAudio = true, allowExternalTriggers = true, updateAutoCheck = false)
        }
    }

    @After
    fun tearDown() {
        if (DictationController.isListening) DictationController.cancel(context)
        DictationController.dismiss()
        service?.onDestroy()
        server?.shutdown()
        DictationController.sink = null
    }

    private fun connectAccessibility(): MurmurAccessibilityService {
        val s = Robolectric.buildService(MurmurAccessibilityService::class.java).create().get()
        val connected = android.accessibilityservice.AccessibilityService::class.java.getDeclaredMethod("onServiceConnected")
        connected.isAccessible = true
        connected.invoke(s)
        service = s
        shadowOf(Looper.getMainLooper()).idle()
        return s
    }

    /** Fires [action] at a fresh trampoline and returns it, configured first, already resumed. */
    private fun fire(action: String, configure: (TestEntryActivity.() -> Unit)? = null): TestEntryActivity {
        val intent = Intent(context, TestEntryActivity::class.java).setAction(action)
        val controller = Robolectric.buildActivity(TestEntryActivity::class.java, intent)
        configure?.invoke(controller.get())
        controller.setup()
        shadowOf(Looper.getMainLooper()).idle()
        return controller.get()
    }

    /** The intent the trampoline started (a gate's explanation), from whichever shadow saw it. */
    private fun takeStarted(entry: TestEntryActivity): Intent? =
        shadowOf(entry).nextStartedActivity ?: shadowOf(context).nextStartedActivity

    /** Whether the trampoline (or anything else) started another activity. */
    private fun nothingStarted(entry: TestEntryActivity): Boolean =
        shadowOf(entry).peekNextStartedActivity() == null && shadowOf(context).peekNextStartedActivity() == null

    // ---- commands --------------------------------------------------------------------------------

    @Test
    fun `a toggle from outside starts dictation and the trampoline finishes at once`() {
        connectAccessibility()
        val entry = fire(EntryActions.TOGGLE_DICTATION)
        assertTrue("pill should be listening", DictationController.state.value is DictationState.Listening)
        assertTrue("trampoline should be gone", entry.isFinishing)
        assertTrue("no gate was shut, nothing else opens", nothingStarted(entry))
        DictationController.cancel(context)
    }

    @Test
    fun `a second toggle stops the dictation`() {
        connectAccessibility()
        // The same in-process STT endpoint DictationFlowTest uses. The service's own insertion
        // waits out its target-lookup retries on Robolectric's paused main clock, so a plain sink
        // stands in for it here (DictationFlowTest does the same); the session ends inserted.
        server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse =
                    MockResponse().setHeader("Content-Type", "application/json").setBody("""{"text":"hello from outside"}""")
            }
            start()
        }
        SettingsStore.get(context).update {
            it.copy(
                sttBaseUrl = "http://${server!!.hostName}:${server!!.port}/v1",
                sttApiKey = "test-key",
                sttModel = "mock-whisper",
                sttFallbackModel = "",
                formattingMode = FormattingMode.LIGHT,
                llmSameAsStt = true,
                llmModel = ""
            )
        }
        DictationController.sink = object : TextSink {
            override suspend fun insert(text: String, pressEnter: Boolean): String? = null
            override fun focusedPackage(): String = "app.murmur.android"
        }
        fire(EntryActions.TOGGLE_DICTATION)
        assertTrue(DictationController.state.value is DictationState.Listening)

        // A trigger fired long enough after the first one (the window resets) stops the session.
        DictationEntryActivity.resetDebounce()
        fire(EntryActions.TOGGLE_DICTATION)
        assertTrue("release moves the pill on", DictationController.state.value is DictationState.Processing)
        assertEquals(DictationState.Success("Inserted"), awaitTerminal())
        DictationController.dismiss()
    }

    @Test
    fun `a start while listening leaves the session alone`() {
        connectAccessibility()
        fire(EntryActions.TOGGLE_DICTATION)
        Thread.sleep(1150) // the fixture session's clock ticks once a second
        DictationEntryActivity.resetDebounce()
        fire(EntryActions.START_DICTATION)
        val listening = DictationController.state.value as DictationState.Listening
        assertTrue("the session did not restart (elapsed ${listening.elapsedSec})", listening.elapsedSec >= 1)
        DictationController.cancel(context)
    }

    @Test
    fun `stop and cancel while idle are no-ops that open nothing`() {
        connectAccessibility()
        for (action in listOf(EntryActions.STOP_DICTATION, EntryActions.CANCEL_DICTATION)) {
            DictationEntryActivity.resetDebounce()
            val entry = fire(action)
            assertTrue("nothing to stop", DictationController.state.value is DictationState.Idle)
            assertTrue(entry.isFinishing)
            assertTrue(nothingStarted(entry))
        }
    }

    // ---- gates -----------------------------------------------------------------------------------

    @Test
    fun `a shut gate opens Murmur on Permissions and never records`() {
        connectAccessibility()
        shadowOf(context).denyPermissions(Manifest.permission.RECORD_AUDIO)
        val entry = fire(EntryActions.TOGGLE_DICTATION)
        assertTrue("no recording without the microphone", DictationController.state.value is DictationState.Idle)
        assertTrue(entry.isFinishing)
        val started = takeStarted(entry)
        assertNotNull("Murmur opens to explain", started)
        assertEquals(MainActivity::class.java.name, started!!.component?.className)
        assertEquals("PERMISSIONS", started.getStringExtra("app.murmur.android.ROUTE"))
    }

    @Test
    fun `the accessibility service being off is a shut gate`() {
        // No service connected: the gate order stops at (c) before anything records.
        val entry = fire(EntryActions.TOGGLE_DICTATION)
        assertTrue(DictationController.state.value is DictationState.Idle)
        val started = takeStarted(entry)
        assertNotNull(started)
        assertEquals("PERMISSIONS", started!!.getStringExtra("app.murmur.android.ROUTE"))
    }

    @Test
    fun `an unfinished onboarding opens Murmur on its onboarding flow`() {
        SettingsStore.get(context).update { it.copy(onboardingComplete = false) }
        connectAccessibility()
        val entry = fire(EntryActions.TOGGLE_DICTATION)
        val started = takeStarted(entry)
        assertNotNull(started)
        assertEquals(MainActivity::class.java.name, started!!.component?.className)
        assertNull("no route: Root shows onboarding itself", started.getStringExtra("app.murmur.android.ROUTE"))
    }

    @Test
    fun `a foreign caller is refused only while external triggers are off`() {
        connectAccessibility()
        SettingsStore.get(context).update { it.copy(allowExternalTriggers = false) }

        // Our own package may always fire, whatever the setting.
        DictationEntryActivity.resetDebounce()
        fire(EntryActions.TOGGLE_DICTATION) { fromPackage = context.packageName }
        assertTrue(DictationController.state.value is DictationState.Listening)
        DictationController.cancel(context)

        // Another app may not.
        DictationEntryActivity.resetDebounce()
        val entry = fire(EntryActions.TOGGLE_DICTATION) { fromPackage = "com.foreign.trigger" }
        assertTrue(DictationController.state.value is DictationState.Idle)
        val started = takeStarted(entry)
        assertNotNull("the refusal explains itself", started)
        assertEquals("PERMISSIONS", started!!.getStringExtra("app.murmur.android.ROUTE"))
        assertTrue(entry.isFinishing)
    }

    // ---- the double-fire, the lock screen, and staying in their app --------------------------------

    @Test
    fun `a shortcut never comes to the front - the command runs before any window`() {
        // Shortcuts are fired with FLAG_ACTIVITY_TASK_ON_HOME: the launch itself moves this
        // task to the front, anchored to home. The command therefore runs (and this finishes)
        // inside onCreate, before a window exists — and the app the user was in is brought back
        // in front, so the anchor never takes them anywhere.
        connectAccessibility()
        val intent = Intent(context, TestEntryActivity::class.java).setAction(EntryActions.TOGGLE_DICTATION)
        val controller = Robolectric.buildActivity(TestEntryActivity::class.java, intent)
        controller.create() // no start(), no setup(): there is nothing to resume
        assertTrue("dictation starts with no window at all", DictationController.state.value is DictationState.Listening)
        assertTrue(controller.get().isFinishing)
        DictationController.cancel(context)
    }

    @Test
    fun `the app the user was in is brought back to the front after the command`() {
        connectAccessibility()
        MurmurAccessibilityService.frontApp = "com.their.app"
        val entry = fire(EntryActions.TOGGLE_DICTATION)
        assertTrue(DictationController.state.value is DictationState.Listening)
        assertEquals("the return happens after every command", 1, entry.bringBacks)
        DictationController.cancel(context)
        MurmurAccessibilityService.frontApp = null
    }

    @Test
    fun `nothing is brought back when the user was on the home screen`() {
        connectAccessibility()
        val now = android.os.SystemClock.uptimeMillis()
        MurmurAccessibilityService.recordFront("com.their.app", now - 60_000, activity = true)
        MurmurAccessibilityService.recordFront("com.home", now - 30_000, activity = true)
        assertNull(MurmurAccessibilityService.appToReturnTo("com.home", launchedAt = now))
    }

    @Test
    fun `the service remembers the app whose window last came to the front`() {
        val service = connectAccessibility()
        fun windowOf(pkg: String) {
            val event = android.view.accessibility.AccessibilityEvent.obtain(
                android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            )
            event.packageName = pkg
            service.onAccessibilityEvent(event)
        }
        windowOf("com.their.app")
        assertEquals("com.their.app", MurmurAccessibilityService.frontApp)
        // System furniture never counts as the app the user is in.
        windowOf("com.android.systemui")
        assertEquals("com.their.app", MurmurAccessibilityService.frontApp)
        MurmurAccessibilityService.frontApp = null
    }

    @Test
    fun `the return launch brings their existing task forward the way its icon does`() {
        connectAccessibility()
        shadowOf(context.packageManager).addActivityIfNotPresent(android.content.ComponentName("com.their.app", "com.their.app.Main"))
        shadowOf(context.packageManager).addIntentFilterForActivity(
            android.content.ComponentName("com.their.app", "com.their.app.Main"),
            android.content.IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) }
        )
        MurmurAccessibilityService.recordFront("com.their.app", android.os.SystemClock.uptimeMillis() - 5_000, activity = true)
        val entry = fire(EntryActions.TOGGLE_DICTATION)
        val started = takeStarted(entry)
        assertNotNull("their app is launched back to the front", started)
        assertEquals("com.their.app", started!!.component?.packageName)
        val wanted = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
        assertEquals("an existing task comes forward instead of gaining a new screen",
            wanted, started.flags and wanted)
        DictationController.cancel(context)
        MurmurAccessibilityService.frontApp = null
    }

    @Test
    fun `window changes caused by the launch itself do not count as where the user was`() {
        val launchedAt = 100_000L
        MurmurAccessibilityService.recordFront("com.their.app", launchedAt - 20_000, activity = true)
        // The shortcut launch moved home to the front and its feed panel came with it, both
        // stamped around the launch and delivered in no particular order.
        MurmurAccessibilityService.recordFront("com.google.android.googlequicksearchbox", launchedAt - 250, activity = false)
        MurmurAccessibilityService.recordFront("com.home", launchedAt - 300, activity = true)
        assertEquals("com.their.app", MurmurAccessibilityService.appToReturnTo("com.home", launchedAt))
    }

    @Test
    fun `events are ordered by when they happened, not when they arrived`() {
        val launchedAt = 100_000L
        MurmurAccessibilityService.recordLaunch(launchedAt - 6_000)
        // The previous command returned them to their app; home's event from that launch is
        // stamped earlier but arrived later.
        MurmurAccessibilityService.recordFront("com.their.app", launchedAt - 5_400, activity = true)
        MurmurAccessibilityService.recordFront("com.home", launchedAt - 5_800, activity = true)
        assertEquals("com.their.app", MurmurAccessibilityService.appToReturnTo("com.home", launchedAt))
    }

    @Test
    fun `a panel another app adds over the home screen is not an app the user was in`() {
        val launchedAt = 100_000L
        MurmurAccessibilityService.recordFront("com.their.app", launchedAt - 60_000, activity = true)
        MurmurAccessibilityService.recordFront("com.home", launchedAt - 30_000, activity = true)
        MurmurAccessibilityService.recordFront("com.google.android.googlequicksearchbox", launchedAt - 29_000, activity = false)
        assertNull("they were on home, so nothing is launched",
            MurmurAccessibilityService.appToReturnTo("com.home", launchedAt))
    }

    @Test
    fun `the ignored second fire of a double tap also puts their app back`() {
        connectAccessibility()
        fire(EntryActions.TOGGLE_DICTATION)
        val second = fire(EntryActions.TOGGLE_DICTATION)
        assertEquals("its launch moved home forward too, so it returns them as well", 1, second.bringBacks)
        assertTrue(second.isFinishing)
        DictationController.cancel(context)
        MurmurAccessibilityService.frontApp = null
    }

    @Test
    fun `a trigger that double-fires inside the debounce window is one command`() {
        connectAccessibility()
        fire(EntryActions.TOGGLE_DICTATION)
        fire(EntryActions.TOGGLE_DICTATION)
        assertTrue("the second fire is ignored, so the session runs on",
            DictationController.state.value is DictationState.Listening)
        DictationController.cancel(context)
    }

    @Test
    fun `a locked keyguard holds the command until it is dismissed`() {
        connectAccessibility()
        val entry = fire(EntryActions.TOGGLE_DICTATION) { lockKeyguard = true }
        assertEquals("the lock screen is asked to dismiss", 1, entry.dismissals)
        assertTrue("nothing runs behind the lock", DictationController.state.value is DictationState.Idle)
        assertFalse(entry.isFinishing)

        // The user got past it: only now does the dictation start.
        entry.heldDismissal?.invoke()
        assertTrue(DictationController.state.value is DictationState.Listening)
        DictationController.cancel(context)
    }

    @Test
    fun `a dismissal the user does not finish runs nothing`() {
        connectAccessibility()
        val entry = fire(EntryActions.TOGGLE_DICTATION) { lockKeyguard = true }
        entry.finish() // what the real callback does when the user walks away from the bouncer
        assertTrue(entry.isFinishing)
        assertTrue(DictationController.state.value is DictationState.Idle)
    }

    /** The release under way settles on a result (the pill's own tests wait the same way). */
    private fun awaitTerminal(timeoutMs: Long = 30_000): DictationState {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            when (val s = DictationController.state.value) {
                is DictationState.Success, is DictationState.Error -> return s
                else -> Thread.sleep(25)
            }
        }
        throw AssertionError("dictation never finished; last state ${DictationController.state.value}")
    }
}

/** The trampoline with its keyguard and caller steered from the test. */
class TestEntryActivity : DictationEntryActivity() {
    var lockKeyguard = false
    var fromPackage: String? = null
    var dismissals = 0
    var bringBacks = 0
    var heldDismissal: (() -> Unit)? = null

    override fun keyguardLocked() = lockKeyguard
    override fun launchedFrom(): String? = fromPackage ?: super.launchedFrom()
    override fun bringBackTheAppTheyWereIn() {
        bringBacks++
        super.bringBackTheAppTheyWereIn()
    }
    override fun requestKeyguardDismissed(run: () -> Unit) {
        dismissals++
        heldDismissal = run
    }
}
