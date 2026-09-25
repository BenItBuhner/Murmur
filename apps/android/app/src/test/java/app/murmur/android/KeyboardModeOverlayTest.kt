package app.murmur.android

import android.app.Activity
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import app.murmur.android.dictation.DictationMode
import app.murmur.android.dictation.DictationState
import app.murmur.android.inference.LimitNotice
import app.murmur.android.keyboard.KeyboardPresence
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayGeometry
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.service.MurmurAccessibilityService
import app.murmur.android.settings.DesktopOverlay
import app.murmur.android.settings.OverlayShape
import app.murmur.android.settings.SettingsStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowChoreographer
import org.robolectric.shadows.ShadowLooper
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.shadows.ShadowWindowManagerImpl
import java.time.Duration
import kotlin.math.abs

private const val PHONE_PORTRAIT = "sw411dp-w411dp-h891dp-port-xxhdpi"
private const val PHONE_LANDSCAPE = "sw411dp-w891dp-h411dp-land-xxhdpi"
private const val TABLET_PORTRAIT = "sw800dp-w800dp-h1280dp-port-xhdpi"
private const val TABLET_LANDSCAPE = "sw800dp-w1280dp-h800dp-land-xhdpi"
private const val IME_ID = 7
private const val IME_PACKAGE = "com.samsung.android.honeyboard"

/**
 * Keyboard mode's idle bar through the real accessibility service and its two overlay windows, and
 * which mode a device lands in as it is turned or has a keyboard attached.
 *
 * Taps are delivered the way Android's input dispatcher picks a window ([tap]): the topmost window
 * whose frame holds the point and that takes touches (a window with FLAG_NOT_TOUCHABLE is skipped
 * entirely), the app underneath last.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = PHONE_PORTRAIT)
class KeyboardModeOverlayTest {

    private lateinit var service: MurmurAccessibilityService
    private lateinit var app: Activity
    private var appTaps = 0
    private var micTaps = 0
    private var confirmTaps = 0
    private val scratch = Canvas(Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888))

    /** Centred, 25 dp above the keyboard: where the floating button rests in these tests. */
    private val spot = OverlayAnchor(0.5f, 25f)

    @Before
    fun setUp() {
        // The pill's window is attached, so its frames go through the Choreographer, which would
        // otherwise move the clock on by its frame delay each time the pill asks for one.
        ShadowChoreographer.setPaused(true)
        app = Robolectric.buildActivity(Activity::class.java).setup().get()
        app.setContentView(View(app).apply { setOnClickListener { appTaps++ } }, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        service = Robolectric.buildService(MurmurAccessibilityService::class.java).create().get()
        SettingsStore.get(service).update {
            it.copy(
                updateAutoCheck = false,
                overlayShape = OverlayShape.PILL,
                overlayLayout = OverlayLayout(listOf(spot)),
                keyboard = it.keyboard.copy(desktopOverlay = DesktopOverlay.AUTO, showOverlayWhenIdle = true, tapIdleBarToDictate = false)
            )
        }
        val connected = android.accessibilityservice.AccessibilityService::class.java.getDeclaredMethod("onServiceConnected")
        connected.isAccessible = true
        connected.invoke(service)
        ShadowLooper.idleMainLooper()
    }

    @After
    fun tearDown() {
        service.onDestroy()
        ShadowChoreographer.setPaused(false)
        // KeyboardPresence is one per process and outlives this test: leave it a keyboard-less phone.
        KeyboardPresence.get(RuntimeEnvironment.getApplication()).refresh(Configuration())
    }

    // ---- the device -------------------------------------------------------------------------------

    /** The display takes [qualifiers], a keyboard is attached or not, and the service hears of it as Android tells it. */
    private fun device(qualifiers: String, keyboard: Boolean) {
        RuntimeEnvironment.setQualifiers(qualifiers)
        val config = Configuration(RuntimeEnvironment.getApplication().resources.configuration).apply {
            this.keyboard = if (keyboard) Configuration.KEYBOARD_QWERTY else Configuration.KEYBOARD_NOKEYS
            hardKeyboardHidden = if (keyboard) Configuration.HARDKEYBOARDHIDDEN_NO else Configuration.HARDKEYBOARDHIDDEN_YES
        }
        service.onConfigurationChanged(config)
        settle()
    }

    private val density: Float get() = RuntimeEnvironment.getApplication().resources.displayMetrics.density

    private fun screen(): Pair<Int, Int> =
        service.getSystemService(WindowManager::class.java).currentWindowMetrics.bounds.let { it.width() to it.height() }

    /** The soft keyboard, docked at the bottom of the screen and [heightDp] tall; null: none. */
    private fun softKeyboard(heightDp: Int?) {
        val windows = if (heightDp == null) emptyList() else {
            val (w, h) = screen()
            val top = h - (heightDp * density).toInt()
            listOf(AccessibilityWindowInfo.obtain().also { window ->
                shadowOf(window).apply {
                    setType(AccessibilityWindowInfo.TYPE_INPUT_METHOD)
                    setId(IME_ID)
                    setBoundsInScreen(Rect(0, top, w, h))
                    setRoot(AccessibilityNodeInfo.obtain().apply {
                        setBoundsInScreen(Rect(0, top, w, h))
                        packageName = IME_PACKAGE
                    })
                }
            })
        }
        shadowOf(service).setWindows(windows)
        service.onAccessibilityEvent(AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOWS_CHANGED))
        settle()
    }

    /** Frames go by, the pill drawing each one (its morphs and fades advance as it draws). */
    private fun settle(frames: Int = 60) {
        repeat(frames) {
            ShadowSystemClock.advanceBy(Duration.ofMillis(8))
            ShadowLooper.idleMainLooper()
            pill()?.draw(scratch)
        }
        ShadowLooper.idleMainLooper()
    }

    // ---- the overlay windows ------------------------------------------------------------------------

    private fun overlays(): List<View> =
        Shadow.extract<ShadowWindowManagerImpl>(service.getSystemService(WindowManager::class.java)).views
            .filter { (it.layoutParams as? WindowManager.LayoutParams)?.type == WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY }

    private fun pill(): OverlayPillView? = overlays().filterIsInstance<OverlayPillView>().singleOrNull()

    private fun touchWindow(): View? = overlays().singleOrNull { it !is OverlayPillView }

    private fun params(v: View) = v.layoutParams as WindowManager.LayoutParams

    private fun takesTouches(v: View) = params(v).flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE == 0

    private fun frameOf(v: View): Box = params(v).let { Box(it.x.toFloat(), it.y.toFloat(), (it.x + it.width).toFloat(), (it.y + it.height).toFloat()) }

    /** The pill's callbacks, counted instead of starting a real recording. */
    private fun countTaps() {
        pill()?.apply {
            onMicTap = { micTaps++ }
            onConfirmTap = { confirmTaps++ }
            onCancelTap = {}
            onDismissTap = {}
            onUpgradeTap = {}
            onOwnModelTap = {}
        }
    }

    /**
     * A tap at (x, y) on the screen, delivered as Android's input dispatcher delivers it: to the
     * topmost overlay window that takes touches and whose frame holds the point, otherwise to the
     * app underneath. Returns true when an overlay window took it.
     */
    private fun tap(x: Float, y: Float): Boolean {
        countTaps()
        val window = overlays().lastOrNull { takesTouches(it) && frameOf(it).contains(x, y) }
        val target = window ?: app.window.decorView
        val t = SystemClock.uptimeMillis()
        for ((action, time) in listOf(MotionEvent.ACTION_DOWN to t, MotionEvent.ACTION_UP to t + 40)) {
            val event = MotionEvent.obtain(t, time, action, x, y, 0)
            if (window != null) event.offsetLocation(-params(window).x.toFloat(), -params(window).y.toFloat())
            target.dispatchTouchEvent(event)
            event.recycle()
        }
        // The next frames: a click is posted, and a view redrawn since holds it back until one is drawn.
        settle(frames = 2)
        return window != null
    }

    private fun dp(v: Float) = v * density

    /** [value], which must be there. */
    private fun <T> present(message: String, value: T?): T {
        assertNotNull(message, value)
        return value!!
    }

    private fun <T> present(value: T?): T = present("expected a value", value)

    // ---- keyboard mode: the idle bar ---------------------------------------------------------------

    @Test
    fun `in keyboard mode the idle bar takes no touches and a tap on it reaches the app beneath`() {
        device(PHONE_PORTRAIT, keyboard = true)
        val bar = present("the idle bar is up with a keyboard attached", touchWindow()).let { frameOf(it) }
        val canvas = present(pill())
        assertFalse("the bar's touch window is skipped by input dispatch", takesTouches(touchWindow()!!))
        assertFalse(takesTouches(canvas))

        assertFalse("on the bar", tap(bar.centerX, bar.centerY))
        assertFalse("where the old 44 dp target reached", tap(bar.centerX, bar.centerY - dp(12f)))
        assertEquals("both taps went to the app", 2, appTaps)
        assertEquals("and none started a dictation", 0, micTaps)
    }

    @Test
    fun `with Tap the idle bar to dictate on, only the bar and 6 dp around it take a tap`() {
        device(PHONE_PORTRAIT, keyboard = true)
        SettingsStore.get(service).update { it.copy(keyboard = it.keyboard.copy(tapIdleBarToDictate = true)) }
        settle()
        val window = present(touchWindow())
        assertTrue(takesTouches(window))
        val target = frameOf(window)
        assertEquals("56 dp bar + 6 dp each side", dp(68f), target.width, 1.5f)
        assertEquals("6 dp bar + 6 dp above and below", dp(18f), target.height, 1.5f)

        assertTrue("on the bar", tap(target.centerX, target.centerY))
        assertEquals(1, micTaps)
        assertFalse("12 dp above the bar", tap(target.centerX, target.centerY - dp(12f)))
        assertFalse("14 dp beside its end", tap(target.left - dp(8f), target.centerY))
        assertEquals("only the tap on the bar started a dictation", 1, micTaps)
        assertEquals("the other two reached the app", 2, appTaps)
    }

    @Test
    fun `listening, transcribing and a limit notice with buttons take taps, then the idle bar lets them through again`() {
        device(PHONE_PORTRAIT, keyboard = true)
        val view = present(pill())
        val notice = LimitNotice(
            limit = "wordsPerWeek", plan = "free", planState = "free", used = 503.0, allowed = 500.0,
            resetsAt = System.currentTimeMillis() + 2 * 86_400_000L, upgradeUrl = "https://murmur.app/upgrade",
            accountUrl = "https://murmur.app/account", message = "This week's 500 free words are used up."
        )
        val states = listOf(
            DictationState.Listening(3, 0.5f, DictationMode.HANDS_FREE, locked = true),
            DictationState.Processing("Transcribing…"),
            DictationState.Error(notice.message, retryId = "entry-1", limit = notice)
        )
        for (state in states) {
            view.render(state)
            settle()
            val window = present(touchWindow())
            assertTrue("$state takes touches", takesTouches(window))
            val frame = frameOf(window)
            assertTrue("$state: a tap on the pill goes to the pill", tap(frame.centerX, frame.centerY))
        }
        assertEquals("the listening pill without touch controls stops on a tap", 1, confirmTaps)

        view.render(DictationState.Idle)
        settle()
        assertFalse("idle again: no touches", takesTouches(touchWindow()!!))
        val bar = frameOf(touchWindow()!!)
        assertFalse(tap(bar.centerX, bar.centerY))
        assertEquals(1, appTaps)
    }

    @Test
    fun `switching into and out of keyboard mode updates the touch window live`() {
        device(PHONE_PORTRAIT, keyboard = false)
        softKeyboard(heightDp = 300)
        val button = present("the floating button is up with the soft keyboard", touchWindow())
        assertTrue(takesTouches(button))
        assertEquals("the button: 36 dp + 6 dp above and below", dp(48f), frameOf(button).height, 1.5f)

        device(PHONE_PORTRAIT, keyboard = true)
        assertFalse("a keyboard attached: the idle bar, taking no touches", takesTouches(touchWindow()!!))
        // Turned on once the bar has settled: the bar and 6 dp around it, not reaching back to where the button was.
        SettingsStore.get(service).update { it.copy(keyboard = it.keyboard.copy(tapIdleBarToDictate = true)) }
        settle()
        assertTrue(takesTouches(touchWindow()!!))
        assertEquals(dp(68f), frameOf(touchWindow()!!).width, 1.5f)
        assertEquals(dp(18f), frameOf(touchWindow()!!).height, 1.5f)
        SettingsStore.get(service).update { it.copy(keyboard = it.keyboard.copy(tapIdleBarToDictate = false)) }
        settle()
        assertFalse(takesTouches(touchWindow()!!))

        device(PHONE_PORTRAIT, keyboard = false)
        val again = present(touchWindow())
        assertTrue("the keyboard gone: the floating button, taking taps again", takesTouches(again))
        assertEquals(dp(48f), frameOf(again).height, 1.5f)

        SettingsStore.get(service).update { it.copy(keyboard = it.keyboard.copy(tapIdleBarToDictate = true)) }
        device(PHONE_PORTRAIT, keyboard = true)
        assertTrue("with the setting on, the bar takes taps", takesTouches(touchWindow()!!))
        assertEquals(dp(18f), frameOf(touchWindow()!!).height, 1.5f)
        SettingsStore.get(service).update { it.copy(keyboard = it.keyboard.copy(tapIdleBarToDictate = false)) }
        settle()
        assertFalse("and none once it is turned off again", takesTouches(touchWindow()!!))
    }

    // ---- which mode, turned either way -----------------------------------------------------------

    @Test
    fun `a phone turned on its side keeps the floating button and shows no idle bar`() {
        device(PHONE_PORTRAIT, keyboard = false)
        assertTrue("no soft keyboard, no button, no bar", overlays().isEmpty())
        device(PHONE_LANDSCAPE, keyboard = false)
        assertTrue("on its side: still nothing, not the keyboard-mode bar", overlays().isEmpty())

        // With the soft keyboard up, the button sits on its spot above it, in either orientation.
        for (qualifiers in listOf(PHONE_LANDSCAPE, PHONE_PORTRAIT, PHONE_LANDSCAPE)) {
            device(qualifiers, keyboard = false)
            softKeyboard(heightDp = if (qualifiers == PHONE_LANDSCAPE) 200 else 300)
            val window = present("$qualifiers: the floating button", touchWindow())
            assertTrue(takesTouches(window))
            val (w, h) = screen()
            assertEquals("$qualifiers: the screen is turned ($w x $h)", qualifiers == PHONE_LANDSCAPE, w > h)
            val keyboardTop = h - (if (qualifiers == PHONE_LANDSCAPE) 200 else 300) * density
            val (x, y) = OverlayGeometry.anchorPoint(spot, w.toFloat(), h.toFloat(), keyboardTop, density, dp(64f), dp(36f))
            val frame = frameOf(window)
            assertTrue("$qualifiers: on its spot, $frame around ($x, $y)", abs(frame.centerX - x) <= 1.5f && abs(frame.centerY - y) <= 1.5f)
            assertEquals(dp(48f), frame.height, 1.5f)
            softKeyboard(heightDp = null)
            assertTrue("$qualifiers: gone with the keyboard", overlays().isEmpty())
        }
    }

    @Test
    fun `a phone with a keyboard keeps the idle bar when turned`() {
        device(PHONE_PORTRAIT, keyboard = true)
        present(touchWindow())
        device(PHONE_LANDSCAPE, keyboard = true)
        val bar = present("on its side with the keyboard: still the idle bar", touchWindow())
        assertFalse(takesTouches(bar))
        device(PHONE_PORTRAIT, keyboard = true)
        assertFalse(takesTouches(present(touchWindow())))
    }

    @Test
    @Config(qualifiers = TABLET_PORTRAIT)
    fun `a tablet shows the keyboard-mode bar either way up, taking a tap without a keyboard`() {
        for (qualifiers in listOf(TABLET_PORTRAIT, TABLET_LANDSCAPE, TABLET_PORTRAIT)) {
            device(qualifiers, keyboard = false)
            val bar = present("$qualifiers: the idle bar", touchWindow())
            assertTrue("$qualifiers: no keyboard, no shortcuts, so the bar takes a tap", takesTouches(bar))
            assertEquals(dp(18f), frameOf(bar).height, 1.5f)
        }
        device(TABLET_LANDSCAPE, keyboard = true)
        assertFalse("with a keyboard the bar lets taps through", takesTouches(present(touchWindow())))
    }
}
