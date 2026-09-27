package app.murmur.android

import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import app.murmur.android.keyboard.KeyboardPresence
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayGeometry
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.service.KeyboardTimingLog
import app.murmur.android.service.MurmurAccessibilityService
import app.murmur.android.settings.DesktopOverlay
import app.murmur.android.settings.OverlayShape
import app.murmur.android.settings.SettingsStore
import org.junit.After
import org.junit.Assert.assertEquals
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
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowAccessibilityRecord
import org.robolectric.shadows.ShadowChoreographer
import org.robolectric.shadows.ShadowLooper
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.shadows.ShadowWindowManagerImpl
import org.xmlpull.v1.XmlPullParser
import java.time.Duration
import java.util.concurrent.Executor
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

private const val SCREEN_W = 1080
private const val SCREEN_H = 2400
private const val DENSITY = 3f
private const val FRAME_MS = 8L
private const val FRAME_TOP = 1500
private const val IME_ID = 7
private const val NAV_BAR_ID = 9
private const val IME_PACKAGE = "com.samsung.android.honeyboard"
private const val APP_ID = 3
private const val APP_PACKAGE = "com.example.chat"

/** Samsung Keyboard's slide out as the recording shows it (frames 752-767), counted in 8 ms frames. */
private const val SLIDE_FRAMES = 16

/** Its slide in (frames 908-931 of the recording): 23 frames. */
private const val SLIDE_IN_FRAMES = 23

/** The report of the keyboard at rest: the window list is computed once nothing has moved for 35 ms (184 + 35 ms). */
private const val REST_REPORT_FRAME = 28

/** The frame in which a 450 ms wait from the first report ends (456 ms). */
private const val ARRIVAL_WAIT_FRAME = 57

/**
 * The pill as the keyboard comes and goes, one 8 ms frame at a time, through the real accessibility
 * service fed the way Android feeds it.
 *
 * Bennett's recording, closing the keyboard with the chevron under its keys: the finger comes down at
 * frame 746 and lifts around 751, the keyboard starts to move at 752 and is gone at 768, and the pill
 * sits unmoved through the whole slide and 10 frames beyond. The report of the keyboard's window
 * going only comes once the slide is over (AccessibilityWindowsPopulator waits for windows to stop
 * moving), and the chevron's Back never reaches the key filter (it is injected, and injected keys
 * skip it), so the earliest sign is the chevron's click, sent as the finger lifts right after it told
 * the keyboard to go: about one frame before the keyboard moves. Here the click comes in the frame
 * before the first moving one, and the pill must be gone by then. Opening, the pill must never be
 * seen anywhere but where the keyboard comes to rest, and comes in with a short fade and scale rather
 * than popping up.
 *
 * [FrameworkDispatch] is the framework's side of event delivery
 * (AbstractAccessibilityServiceConnection.notifyAccessibilityEvent): each event is held for the
 * service's configured notification timeout, a newer one of the same type restarting the wait.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xxhdpi")
class KeyboardTransitionTest {

    private class FrameworkDispatch(private val timeoutMs: Long, private val deliver: (AccessibilityEvent) -> Unit) {
        private val pending = HashMap<Int, Pair<AccessibilityEvent, Long>>()

        fun post(event: AccessibilityEvent, now: Long) {
            if (timeoutMs <= 0L) deliver(event) else pending[event.eventType] = event to now + timeoutMs
        }

        fun deliverDue(now: Long) {
            for ((type, entry) in pending.filterValues { it.second <= now }) {
                pending.remove(type)
                deliver(entry.first)
            }
        }
    }

    /** What the screen shows of the pill in a frame: how opaque its body is (0..1) and where its centre is. */
    private data class Look(val opacity: Float, val x: Float, val y: Float)

    private lateinit var service: MurmurAccessibilityService
    private lateinit var dispatch: FrameworkDispatch
    private var now = 0L
    private val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)
    private val pixels = IntArray(SCREEN_W * SCREEN_H)

    /** Just above the keyboard, in the middle: where following the keyboard, or not, shows. */
    private val spot = OverlayAnchor(0.5f, 25f)

    private fun declaredNotificationTimeout(): Long {
        val parser = service.resources.getXml(R.xml.accessibility_service_config)
        while (parser.next() != XmlPullParser.END_DOCUMENT) {
            if (parser.eventType == XmlPullParser.START_TAG && parser.name == "accessibility-service") {
                return parser.getAttributeIntValue("http://schemas.android.com/apk/res/android", "notificationTimeout", 0).toLong()
            }
        }
        return 0L
    }

    @Before
    fun setUp() {
        // The pill's window is attached here, so its frames go through the Choreographer, which would
        // otherwise move the clock on by its frame delay each time the pill asks for one.
        ShadowChoreographer.setPaused(true)
        KeyboardTimingLog.clear()
        service = Robolectric.buildService(MurmurAccessibilityService::class.java).create().get()
        SettingsStore.get(service).update {
            it.copy(
                updateAutoCheck = false,
                overlayShape = OverlayShape.PILL,
                overlayLayout = OverlayLayout(listOf(spot)),
                keyboard = it.keyboard.copy(desktopOverlay = DesktopOverlay.OFF)
            )
        }
        val connected = android.accessibilityservice.AccessibilityService::class.java.getDeclaredMethod("onServiceConnected")
        connected.isAccessible = true
        connected.invoke(service)
        // Reads of other apps' views answer at once here; the tests that care where they run put in their own.
        service.reads = Executor { it.run() }
        ShadowLooper.idleMainLooper()
        dispatch = FrameworkDispatch(declaredNotificationTimeout()) { service.onAccessibilityEvent(it) }
    }

    @After
    fun tearDown() {
        service.onDestroy()
        ShadowChoreographer.setPaused(false)
        // KeyboardPresence is one per process and outlives this test: leave it a keyboard-less phone.
        KeyboardPresence.get(RuntimeEnvironment.getApplication()).refresh(Configuration())
    }

    // ---- the world ------------------------------------------------------------------------------

    /**
     * The keyboard's window as the list reports it: [reportedTop] is its touchable top edge where
     * SurfaceFlinger has it in that frame (mid-slide during an animation); its views are laid out
     * from [frameTop] (null: its root cannot be read).
     */
    private fun ime(reportedTop: Int, frameTop: Int? = FRAME_TOP): AccessibilityWindowInfo {
        val window = AccessibilityWindowInfo.obtain()
        shadowOf(window).apply {
            setType(AccessibilityWindowInfo.TYPE_INPUT_METHOD)
            setId(IME_ID)
            setBoundsInScreen(Rect(0, reportedTop, SCREEN_W, SCREEN_H))
            if (frameTop != null) {
                setRoot(AccessibilityNodeInfo.obtain().apply {
                    setBoundsInScreen(Rect(0, frameTop, SCREEN_W, SCREEN_H))
                    packageName = IME_PACKAGE
                })
            }
        }
        return window
    }

    /** Whether the app being typed into is in the window list, in front and taking input (the anticipation tests). */
    private var appInFront = false

    private fun appWindow(): AccessibilityWindowInfo {
        val window = AccessibilityWindowInfo.obtain()
        shadowOf(window).apply {
            setType(AccessibilityWindowInfo.TYPE_APPLICATION)
            setId(APP_ID)
            setBoundsInScreen(Rect(0, 0, SCREEN_W, SCREEN_H))
            setActive(true)
            setFocused(true)
        }
        return window
    }

    private fun navBar(): AccessibilityWindowInfo {
        val window = AccessibilityWindowInfo.obtain()
        shadowOf(window).apply {
            setType(AccessibilityWindowInfo.TYPE_SYSTEM)
            setId(NAV_BAR_ID)
            setBoundsInScreen(Rect(0, SCREEN_H - 144, SCREEN_W, SCREEN_H))
        }
        return window
    }

    /**
     * One frame, in a phone's order: the clock moves on to the frame's time; the window list as it now
     * stands, [before] and a report of the list if [report] happen; the main thread runs what is due
     * (the pill's own frame among it); then the screen shows the pill.
     */
    private fun frame(keyboard: AccessibilityWindowInfo?, report: Boolean = false, before: () -> Unit = {}): Look? {
        now += FRAME_MS
        ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
        shadowOf(service).setWindows(listOfNotNull(appWindow().takeIf { appInFront }, keyboard, navBar().takeIf { keyboard != null }))
        before()
        if (report) dispatch.post(AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOWS_CHANGED), now)
        dispatch.deliverDue(now)
        ShadowLooper.idleMainLooper()
        return pillLook()
    }

    /** The overlay windows on screen: the pill's two are kept, hidden, while it is not shown. */
    private fun overlayViews(): List<View> = attachedViews().filter { it.visibility == View.VISIBLE }

    private fun attachedViews(): List<View> =
        Shadow.extract<ShadowWindowManagerImpl>(service.getSystemService(WindowManager::class.java)).views

    private fun pillView(): OverlayPillView? = overlayViews().filterIsInstance<OverlayPillView>().singleOrNull()

    /** Draws the pill's canvas as this frame shows it; null when nothing of the pill is visible. */
    private fun pillLook(): Look? {
        val view = pillView() ?: return null
        bitmap.eraseColor(Color.TRANSPARENT)
        view.draw(canvas)
        bitmap.getPixels(pixels, 0, SCREEN_W, 0, 0, SCREEN_W, SCREEN_H)
        var maxAlpha = 0
        for (p in pixels) maxAlpha = max(maxAlpha, Color.alpha(p))
        if (maxAlpha < 13) return null
        var left = Int.MAX_VALUE
        var top = Int.MAX_VALUE
        var right = Int.MIN_VALUE
        var bottom = Int.MIN_VALUE
        val body = maxAlpha * 9 / 10
        for (y in 0 until SCREEN_H) {
            val row = y * SCREEN_W
            for (x in 0 until SCREEN_W) {
                if (Color.alpha(pixels[row + x]) < body) continue
                left = min(left, x)
                right = max(right, x)
                top = min(top, y)
                bottom = max(bottom, y)
            }
        }
        return Look(maxAlpha / 255f, (left + right + 1) / 2f, (top + bottom + 1) / 2f)
    }

    private fun restingCenter(keyboardTop: Int): Pair<Float, Float> =
        OverlayGeometry.anchorPoint(spot, SCREEN_W.toFloat(), SCREEN_H.toFloat(), keyboardTop.toFloat(), DENSITY, 64 * DENSITY, 36 * DENSITY)

    private fun at(look: Look, keyboardTop: Int): Boolean {
        val (x, y) = restingCenter(keyboardTop)
        return abs(look.x - x) < 1.5f && abs(look.y - y) < 1.5f
    }

    private fun settledAt(look: Look?, keyboardTop: Int = FRAME_TOP) = look != null && look.opacity > 0.99f && at(look, keyboardTop)

    /** A keyboard that is at rest from its first report (its touch area starts level with its frame), the pill settled on it. */
    private fun openSettled() {
        frame(null)
        frame(ime(FRAME_TOP), report = true)
        val look = (1..40).map { frame(ime(FRAME_TOP)) }.last()
        assertTrue("the pill is up and settled before the close: $look", settledAt(look))
    }

    /** A hardware Back key through the service's key filter (protected on AccessibilityService). */
    private fun backKey(action: Int, flags: Int = 0) {
        val t = SystemClock.uptimeMillis()
        val event = KeyEvent(t, t, action, KeyEvent.KEYCODE_BACK, 0, 0, -1, 0, flags or KeyEvent.FLAG_FROM_SYSTEM)
        MurmurAccessibilityService::class.java.getDeclaredMethod("onKeyEvent", KeyEvent::class.java)
            .apply { isAccessible = true }
            .invoke(service, event)
    }

    private fun click(windowId: Int, viewId: String, bounds: Rect): AccessibilityEvent {
        val event = AccessibilityEvent.obtain(AccessibilityEvent.TYPE_VIEW_CLICKED)
        event.packageName = if (windowId == IME_ID) IME_PACKAGE else "com.android.systemui"
        Shadow.extract<ShadowAccessibilityRecord>(event).apply {
            setWindowId(windowId)
            setSourceNode(AccessibilityNodeInfo.obtain().apply {
                viewIdResourceName = viewId
                setBoundsInScreen(bounds)
            })
        }
        return event
    }

    /** The down chevron of the navigation bar the keyboard draws under its keys, bottom right as on the S26 Ultra. */
    private fun chevronClick() = click(IME_ID, "android:id/input_method_nav_back", Rect(SCREEN_W - 216, SCREEN_H - 132, SCREEN_W - 20, SCREEN_H))

    /**
     * Frames of a close whose keyboard first moves at [slideStart]: no report while it slides, the
     * report of its window gone once it is off screen. Each of [signals] happens in the frame it is
     * given for. Returns what the screen showed of the pill in each frame, from the first.
     */
    private fun close(slideStart: Int, signals: Map<Int, () -> Unit> = emptyMap(), midSlideReportAt: Int? = null): List<Look?> {
        val looks = ArrayList<Look?>()
        for (i in 0 until slideStart + SLIDE_FRAMES + 12) {
            val inSlide = i - slideStart
            val gone = inSlide >= SLIDE_FRAMES
            val keyboard = if (gone) null else ime(FRAME_TOP)
            val report = gone && inSlide == SLIDE_FRAMES || i == midSlideReportAt
            val reported = if (i == midSlideReportAt) ime(FRAME_TOP + (SCREEN_H - FRAME_TOP) * inSlide / SLIDE_FRAMES) else keyboard
            looks += frame(reported, report) { signals[i]?.invoke() }
        }
        return looks
    }

    private fun describe(looks: List<Look?>, from: Int) =
        looks.withIndex().drop(from).take(24).joinToString("\n") { (i, l) -> "  frame $i: $l" }

    /** Frames from [from] on in which any of the pill is on screen. */
    private fun visibleFrom(looks: List<Look?>, from: Int) = looks.withIndex().drop(from).count { it.value != null }

    private fun assertGoneByFirstMovingFrame(looks: List<Look?>, tapFrame: Int, slideStart: Int) {
        assertTrue("going in the frame of the tap:\n" + describe(looks, 0), (looks[tapFrame]?.opacity ?: 0f) < 0.99f)
        assertTrue(
            "the pill is on screen in ${visibleFrom(looks, slideStart)} frames after the keyboard started to move:\n" + describe(looks, 0),
            visibleFrom(looks, slideStart) == 0
        )
        assertTrue("and never anywhere but its spot:\n" + describe(looks, 0), looks.filterNotNull().all { at(it, FRAME_TOP) })
        assertTrue("its windows are gone with it", overlayViews().isEmpty())
    }

    // ---- closing ----------------------------------------------------------------------------------

    @Test
    fun `closing with the chevron under the keys the pill is gone by the keyboard's first moving frame`() {
        openSettled()
        val looks = close(slideStart = 6, signals = mapOf(5 to { service.onAccessibilityEvent(chevronClick()) }))
        assertGoneByFirstMovingFrame(looks, tapFrame = 5, slideStart = 6)
    }

    @Test
    fun `a maker's own hide-keyboard button in the keyboard's bottom strip counts too`() {
        openSettled()
        val hide = click(IME_ID, "$IME_PACKAGE:id/keyboard_hide", Rect(SCREEN_W - 216, SCREEN_H - 132, SCREEN_W - 20, SCREEN_H))
        val looks = close(slideStart = 6, signals = mapOf(5 to { service.onAccessibilityEvent(hide) }))
        assertGoneByFirstMovingFrame(looks, tapFrame = 5, slideStart = 6)
    }

    @Test
    fun `the system navigation bar's back button counts too`() {
        openSettled()
        val back = click(NAV_BAR_ID, "com.android.systemui:id/back", Rect(120, SCREEN_H - 144, 330, SCREEN_H))
        val looks = close(slideStart = 6, signals = mapOf(5 to { service.onAccessibilityEvent(back) }))
        assertGoneByFirstMovingFrame(looks, tapFrame = 5, slideStart = 6)
    }

    @Test
    fun `a hardware Back key takes the pill as it goes down, before the keyboard starts to slide`() {
        openSettled()
        val looks = close(slideStart = 6, signals = mapOf(0 to { backKey(KeyEvent.ACTION_DOWN) }, 5 to { backKey(KeyEvent.ACTION_UP) }))
        assertTrue("gone two frames after the key went down:\n" + describe(looks, 0), visibleFrom(looks, 2) == 0)
        assertTrue("and never anywhere but its spot", looks.filterNotNull().all { at(it, FRAME_TOP) })
        assertTrue(overlayViews().isEmpty())
    }

    @Test
    fun `a tap on the keyboard switcher or the accessibility button leaves the pill where it is`() {
        openSettled()
        val switcher = click(IME_ID, "android:id/input_method_nav_ime_switcher", Rect(SCREEN_W - 216, SCREEN_H - 132, SCREEN_W - 20, SCREEN_H))
        val accessibility = click(NAV_BAR_ID, "com.android.systemui:id/accessibility_button", Rect(SCREEN_W - 180, SCREEN_H - 144, SCREEN_W - 36, SCREEN_H))
        val looks = listOf(frame(ime(FRAME_TOP)) { service.onAccessibilityEvent(switcher) }) + (1..30).map { frame(ime(FRAME_TOP)) } +
            listOf(frame(ime(FRAME_TOP)) { service.onAccessibilityEvent(accessibility) }) + (1..30).map { frame(ime(FRAME_TOP)) }
        assertTrue("never dimmed, never moved:\n" + describe(looks, looks.indexOfFirst { !settledAt(it) }.coerceAtLeast(0)), looks.all { settledAt(it) })
    }

    private fun typingIn(app: String) {
        val focus = AccessibilityEvent.obtain(AccessibilityEvent.TYPE_VIEW_FOCUSED)
        focus.packageName = app
        Shadow.extract<ShadowAccessibilityRecord>(focus).setSourceNode(AccessibilityNodeInfo.obtain().apply {
            isEditable = true
            packageName = app
        })
        service.onAccessibilityEvent(focus)
    }

    private fun windowStateChanged(app: String): AccessibilityEvent =
        AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED).also { it.packageName = app }

    @Test
    fun `another app coming up (home, Recents) takes the pill within two frames`() {
        openSettled()
        frame(ime(FRAME_TOP)) { typingIn("com.example.chat") }
        val looks = listOf(frame(ime(FRAME_TOP)) { service.onAccessibilityEvent(windowStateChanged("com.sec.android.app.launcher")) }) +
            (1..10).map { frame(ime(FRAME_TOP)) }
        assertTrue("gone the frame after the launcher came up:\n" + describe(looks, 0), visibleFrom(looks, 1) == 0)
        assertTrue("and never anywhere but its spot", looks.filterNotNull().all { at(it, FRAME_TOP) })
    }

    @Test
    fun `the app being typed into opening a window of its own leaves the pill where it is`() {
        openSettled()
        frame(ime(FRAME_TOP)) { typingIn("com.example.chat") }
        val looks = listOf(frame(ime(FRAME_TOP)) { service.onAccessibilityEvent(windowStateChanged("com.example.chat")) }) +
            (1..30).map { frame(ime(FRAME_TOP)) }
        assertTrue("never dimmed, never moved:\n" + describe(looks, 0), looks.all { settledAt(it) })
    }

    @Test
    fun `a report of the keyboard on its way out takes the pill within two frames, where it is`() {
        openSettled()
        // No sign before the slide (a back gesture); the list happens to be computed once mid-slide.
        val looks = close(slideStart = 0, midSlideReportAt = 6)
        assertTrue("the pill is only ever where it rests:\n" + describe(looks, 0), looks.filterNotNull().all { at(it, FRAME_TOP) })
        assertTrue("and gone two frames after the report:\n" + describe(looks, 0), visibleFrom(looks, 6 + 2) == 0)
    }

    @Test
    fun `a keyboard an app dips while scrolling leaves the pill where it is, never dimmed`() {
        openSettled()
        // Recording frames 308-404: the app pulls the keyboard 65 video px (about 30 dp) down with the
        // scroll and lets it spring back; the list reports it part of the way down, then at rest.
        val dip = (30 * DENSITY).toInt()
        val looks = ArrayList<Look?>()
        looks += frame(ime(FRAME_TOP + dip), report = true)
        repeat(12) { looks += frame(ime(FRAME_TOP + dip)) }
        looks += frame(ime(FRAME_TOP), report = true)
        repeat(30) { looks += frame(ime(FRAME_TOP)) }
        assertTrue("not moved, not faded:\n" + describe(looks, looks.indexOfFirst { !settledAt(it) }.coerceAtLeast(0)), looks.all { settledAt(it) })
    }

    @Test
    fun `a hide-button tap that does not close the keyboard, or a cancelled Back press, brings the pill back where it was`() {
        openSettled()
        frame(ime(FRAME_TOP)) { backKey(KeyEvent.ACTION_DOWN) }
        repeat(5) { frame(ime(FRAME_TOP)) }
        frame(ime(FRAME_TOP)) { backKey(KeyEvent.ACTION_UP, KeyEvent.FLAG_CANCELED) }
        var look = (1..30).map { frame(ime(FRAME_TOP)) }.last()
        assertTrue("back after a cancelled press: $look", settledAt(look))

        frame(ime(FRAME_TOP)) { service.onAccessibilityEvent(chevronClick()) }
        val aside = (1..20).map { frame(ime(FRAME_TOP)) }
        assertTrue("stepped aside at first: $aside", aside.take(10).all { it == null })
        val back = aside + (1..80).map { frame(ime(FRAME_TOP)) }
        assertTrue("and back once the keyboard plainly stayed:\n" + describe(back, 50), settledAt(back.last()))
    }

    @Test
    fun `the keyboard reported gone takes the pill in that frame`() {
        openSettled()
        assertNull("gone in the frame the keyboard's window is reported gone", frame(null, report = true))
        assertTrue(overlayViews().isEmpty())
        repeat(10) { frame(null) }
        assertTrue(overlayViews().isEmpty())
    }

    // ---- opening ----------------------------------------------------------------------------------

    /**
     * An opening reported the way Android reports it (AccessibilityWindowsPopulator): the keyboard's
     * window reported the moment it appears, [firstTop] as it starts to slide in; the slide as the
     * recording shows it (frames 908-931, [SLIDE_IN_FRAMES] frames); then the report of it at rest at
     * [restTop], once it has not moved for 35 ms ([REST_REPORT_FRAME]); then nothing. Frame 0 is the
     * first report. Returns every frame's look.
     */
    private fun open(firstTop: Int, restTop: Int, frameTop: Int?, frames: Int = 90): List<Look?> =
        (0 until frames).map { i ->
            when {
                i == 0 -> frame(ime(firstTop, frameTop), report = true)
                i < SLIDE_IN_FRAMES -> frame(ime(firstTop + (restTop - firstTop) * i / SLIDE_IN_FRAMES, frameTop))
                else -> frame(ime(restTop, frameTop), report = i == REST_REPORT_FRAME)
            }
        }

    private fun closeKeyboard() {
        frame(null, report = true)
        repeat(10) { frame(null) }
    }

    private fun assertOnlyAtRest(looks: List<Look?>, restTop: Int) {
        val elsewhere = looks.withIndex().filter { (_, l) -> l != null && !at(l, restTop) }
        assertTrue("drawn away from where the keyboard rests in ${elsewhere.size} frames:\n" + describe(looks, elsewhere.firstOrNull()?.index ?: 0), elsewhere.isEmpty())
    }

    /** From the keyboard's first report (frame 0): the pill's first frame on screen, and its first at full strength. */
    private class Arrival(looks: List<Look?>) {
        val visible = looks.indexOfFirst { it != null }.takeIf { it >= 0 }
        val full = looks.indexOfFirst { it != null && it.opacity > 0.99f }.takeIf { it >= 0 }
        private val firstOpacity = visible?.let { looks[it]!!.opacity }
        override fun toString() =
            "first on screen at frame $visible (${firstOpacity?.let { (it * 100).toInt() }}% there), at full strength at frame $full"
    }

    /** At full strength from frame [atFrame] on, never before it, and only ever where the keyboard comes to rest. */
    private fun assertArrives(looks: List<Look?>, restTop: Int, atFrame: Int) {
        val arrival = Arrival(looks)
        assertTrue(
            "$arrival; wanted at full strength at frame $atFrame:\n" + describe(looks, max(0, min(atFrame, arrival.visible ?: atFrame) - 2)),
            arrival.visible == atFrame && arrival.full == atFrame
        )
        assertTrue("and there from then on:\n" + describe(looks, atFrame), looks.drop(atFrame).all { it != null && it.opacity > 0.99f })
        assertOnlyAtRest(looks, restTop)
    }

    /** A new service on the same device: what the old one learnt survives only if it was kept. */
    private fun restartService() {
        service.onDestroy()
        setUp()
    }

    @Test
    fun `a returning keyboard's pill is at full strength at its final spot in the frame the keyboard is first reported`() {
        // First time: its touch area starts 15 px below its frame, which is learnt and kept.
        open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP)
        closeKeyboard()
        restartService()
        // Back, after a restart: in at its final spot on the report of it just starting to slide in.
        val looks = open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP, frames = 40)
        assertArrives(looks, FRAME_TOP + 15, atFrame = 0)
    }

    @Test
    fun `a returning keyboard first reported as a sliver rising into view is shown in that frame too`() {
        open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP)
        closeKeyboard()
        // The recording's frame 908: the keyboard's window has just appeared, only its top 60-odd px in view.
        val looks = open(firstTop = SCREEN_H - 60, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP, frames = 40)
        assertArrives(looks, FRAME_TOP + 15, atFrame = 0)
    }

    @Test
    fun `a keyboard seen for the first time is at full strength where it rests on the report of it at rest`() {
        val looks = open(firstTop = 2250, restTop = FRAME_TOP, frameTop = FRAME_TOP)
        assertArrives(looks, FRAME_TOP, atFrame = REST_REPORT_FRAME)
    }

    @Test
    fun `a keyboard seen for the first time whose touch area starts a little below its frame needs no timer either`() {
        // 15 px below its frame: from the frame alone the pill would sit 5 dp too high, so it waits for the report at rest.
        val looks = open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP)
        assertArrives(looks, FRAME_TOP + 15, atFrame = REST_REPORT_FRAME)
    }

    @Test
    fun `a keyboard that appears without sliding is shown in the frame it is first reported`() {
        val looks = open(firstTop = FRAME_TOP + 15, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP)
        assertArrives(looks, FRAME_TOP + 15, atFrame = 0)
    }

    @Test
    fun `a keyboard resting well below its frame is waited for once, then shown at once on every opening`() {
        // 90 px (30 dp) below its frame: past what is taken for a keyboard at rest without waiting.
        val first = open(firstTop = 2250, restTop = FRAME_TOP + 90, frameTop = FRAME_TOP)
        assertArrives(first, FRAME_TOP + 90, atFrame = ARRIVAL_WAIT_FRAME)
        closeKeyboard()
        restartService()
        val again = open(firstTop = 2250, restTop = FRAME_TOP + 90, frameTop = FRAME_TOP, frames = 40)
        assertArrives(again, FRAME_TOP + 90, atFrame = 0)
    }

    @Test
    fun `a keyboard whose frame cannot be read is not shown part of the way up`() {
        val looks = open(firstTop = 2000, restTop = FRAME_TOP, frameTop = null)
        assertArrives(looks, FRAME_TOP, atFrame = ARRIVAL_WAIT_FRAME)
    }

    /** The keyboard the system has selected, as Settings names it: all that identifies a keyboard whose root is hidden. */
    private fun selectKeyboard() {
        Settings.Secure.putString(service.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD, "$IME_PACKAGE/.service.HoneyBoardService")
    }

    @Test
    fun `a keyboard whose frame cannot be read is waited for once, then shown at once on every opening`() {
        selectKeyboard()
        val first = open(firstTop = 2000, restTop = FRAME_TOP, frameTop = null)
        assertArrives(first, FRAME_TOP, atFrame = ARRIVAL_WAIT_FRAME)
        closeKeyboard()
        restartService()
        val again = open(firstTop = 2000, restTop = FRAME_TOP, frameTop = null, frames = 70)
        assertArrives(again, FRAME_TOP, atFrame = 0)
    }

    @Test
    fun `a keyboard in a full-screen window is waited for once, then shown at once on every opening`() {
        val first = open(firstTop = 2250, restTop = FRAME_TOP, frameTop = 0)
        assertArrives(first, FRAME_TOP, atFrame = ARRIVAL_WAIT_FRAME)
        closeKeyboard()
        restartService()
        val again = open(firstTop = 2250, restTop = FRAME_TOP, frameTop = 0, frames = 70)
        assertArrives(again, FRAME_TOP, atFrame = 0)
    }

    @Test
    fun `a keyboard its window does not place that comes to rest lower than last time is moved there once, at the deadline`() {
        selectKeyboard()
        open(firstTop = 2000, restTop = FRAME_TOP, frameTop = null)
        closeKeyboard()
        // A shorter layout this time: at rest 150 px lower. Where it rested last time is all there is
        // to go on until it has had the time any keyboard takes to come to rest.
        val shorter = open(firstTop = 2000, restTop = FRAME_TOP + 150, frameTop = null, frames = 70)
        assertTrue("shown at once, where it rested last time:\n" + describe(shorter, 0), shorter.take(ARRIVAL_WAIT_FRAME).all { it != null && it.opacity > 0.99f && at(it, FRAME_TOP) })
        assertTrue("then where it rests now:\n" + describe(shorter, ARRIVAL_WAIT_FRAME - 2), shorter.drop(ARRIVAL_WAIT_FRAME).all { settledAt(it, FRAME_TOP + 150) })
        closeKeyboard()
        val again = open(firstTop = 2000, restTop = FRAME_TOP + 150, frameTop = null, frames = 70)
        assertArrives(again, FRAME_TOP + 150, atFrame = 0)
    }

    @Test
    fun `the timing log follows an opening from the keyboard's first report to the pill's first frame`() {
        open(firstTop = 2250, restTop = FRAME_TOP + 90, frameTop = FRAME_TOP)
        closeKeyboard()
        open(firstTop = 2250, restTop = FRAME_TOP + 90, frameTop = FRAME_TOP, frames = 40)
        val log = KeyboardTimingLog.text()
        val lines = log.lines()
        fun after(from: Int, text: String): Int {
            val i = lines.withIndex().indexOfFirst { (n, line) -> n > from && text in line }
            assertTrue("no \"$text\" after line $from in:\n$log", i >= 0)
            return i
        }
        // The pill's windows, added hidden when the service connected.
        var at = after(-1, "pill windows added, hidden")
        // The first opening: unknown, so the deadline is armed, fires, and what was learnt is said.
        at = after(at, "== keyboard up #1")
        at = after(at, "kb visible=1 ready=0")
        at = after(at, "arrival deadline armed for +450ms")
        at = after(at, "arrival deadline fired")
        at = after(at, "learnt 90px for $IME_PACKAGE")
        at = after(at, "pill windows made visible")
        at = after(at, "pill first drawn")
        at = after(at, "== keyboard gone #1")
        at = after(at, "pill windows hidden")
        // The second: the report and the window list read with the keyboard's window, placed by the
        // frame read last time; the tracker's verdict and the pill; and only then the root, read again
        // off the main thread. All in the frame the keyboard is first reported.
        at = after(at, "ev WINDOWS")
        at = after(at, "win n=2")
        assertTrue(lines[at], "ime#$IME_ID" in lines[at] && "[0,2250,1080,2400] frame as last read, reading it again" in lines[at])
        at = after(at, "== keyboard up #2")
        at = after(at, "kb visible=1 ready=1 displaced=0 top=${FRAME_TOP + 90}: arriving; rest known from its frame")
        at = after(at, "arrival deadline armed for +450ms, the pill is not waiting for it")
        at = after(at, "pill shown")
        at = after(at, "pill windows made visible")
        at = after(at, "root read")
        assertTrue(lines[at], "on the read thread" in lines[at] && "frame=[0,$FRAME_TOP,1080,2400] $IME_PACKAGE" in lines[at])
        after(at, "pill first drawn")
        val shown = lines.indexOfFirst { "== keyboard up #2" in it }
        assertTrue("nothing waited on in the second opening:\n$log", lines.drop(shown).none { "deadline fired" in it })
    }

    // ---- the pill's windows, reads off the main thread, and the pill ahead of the keyboard -------

    @Test
    fun `the pill's two windows are added once, hidden, and shown and hidden again for every opening`() {
        val windows = attachedViews()
        assertEquals("the canvas and the touch window, added as the service connected", 2, windows.size)
        assertTrue("hidden while no keyboard is up: no surface, nothing drawn", overlayViews().isEmpty())
        fun same() = attachedViews().size == 2 && attachedViews().zip(windows).all { (a, b) -> a === b }
        repeat(3) { n ->
            val looks = open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP, frames = 40)
            assertTrue("opening ${n + 1}: the same two windows, shown", same() && overlayViews().size == 2)
            if (n > 0) assertArrives(looks, FRAME_TOP + 15, atFrame = 0)
            closeKeyboard()
            assertTrue("closed ${n + 1}: hidden again, not removed", same() && overlayViews().isEmpty())
            assertTrue(attachedViews().all { it.visibility == View.INVISIBLE })
        }
    }

    @Test
    fun `the keyboard's report is acted on in its own frame while the reads of other apps' views are still out, none of them on the main thread`() {
        open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP)
        closeKeyboard()
        // A restart: nothing read yet about the keyboard's window, only where it rests is remembered.
        restartService()
        selectKeyboard()
        val held = ArrayList<Runnable>()
        val onMainThread = ArrayList<Boolean>()
        service.reads = Executor { held += it }
        service.readRoot = { window -> onMainThread += Looper.myLooper() == Looper.getMainLooper(); window.root }
        service.readSource = { event -> onMainThread += Looper.myLooper() == Looper.getMainLooper(); event.source }
        frame(null) { typingIn(APP_PACKAGE) }
        val looks = open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP, frames = 3)
        assertTrue("at its final spot in the frame of the report:\n" + describe(looks, 0), looks.all { settledAt(it, FRAME_TOP + 15) })
        assertTrue("with the field's view and the keyboard's root still to be read (${held.size} reads)", held.size >= 2 && onMainThread.isEmpty())
        // The reads come back from a thread of their own; nothing moves.
        Thread { held.toList().forEach { it.run() } }.apply {
            start()
            join()
        }
        held.clear()
        val after = (1..20).map { frame(ime(FRAME_TOP + 15, FRAME_TOP)) }
        assertTrue("unmoved once they are back:\n" + describe(after, 0), after.all { settledAt(it, FRAME_TOP + 15) })
        assertTrue("every read was made off the main thread: $onMainThread", onMainThread.isNotEmpty() && onMainThread.none { it })
        val log = KeyboardTimingLog.text()
        assertTrue(log, "frame not read yet, reading it" in log && "root read" in log && "view read" in log)
    }

    /** The app in front reports [type] on its editable field [viewId]. */
    private fun field(
        type: Int = AccessibilityEvent.TYPE_VIEW_FOCUSED,
        viewId: String = "$APP_PACKAGE:id/compose",
        windowId: Int = APP_ID
    ): AccessibilityEvent {
        val event = AccessibilityEvent.obtain(type)
        event.packageName = APP_PACKAGE
        Shadow.extract<ShadowAccessibilityRecord>(event).apply {
            setWindowId(windowId)
            setSourceNode(AccessibilityNodeInfo.obtain().apply {
                isEditable = true
                packageName = APP_PACKAGE
                viewIdResourceName = viewId
                className = "android.widget.EditText"
            })
        }
        return event
    }

    /** A first opening, 15 px under its frame, and a close, then long enough for the app to settle. */
    private fun learnKeyboard() {
        open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP)
        closeKeyboard()
        repeat(70) { frame(null) }
    }

    private fun attachHardwareKeyboard() {
        service.onConfigurationChanged(
            Configuration(service.resources.configuration).apply {
                keyboard = Configuration.KEYBOARD_QWERTY
                hardKeyboardHidden = Configuration.HARDKEYBOARDHIDDEN_NO
            }
        )
    }

    @Test
    fun `a tap on a field brings the pill up at the keyboard's resting spot ahead of the keyboard, which then changes nothing`() {
        appInFront = true
        learnKeyboard()
        val ahead = listOf(frame(null) { service.onAccessibilityEvent(field()) }) + (1 until 10).map { frame(null) }
        // Bennett's recording, E4: the keyboard's window appears 80 ms after the finger leaves the field.
        val looks = ahead + open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP, frames = 40)
        assertTrue("at its spot and fully there from the tap on:\n" + describe(looks, 0), looks.all { settledAt(it, FRAME_TOP + 15) })
        val log = KeyboardTimingLog.text()
        assertTrue(log, "anticipating the keyboard for $APP_PACKAGE/$APP_PACKAGE:id/compose" in log)
        assertTrue(log, "anticipation confirmed: the keyboard was reported 80ms after the pill went up, resting where anticipated" in log)
    }

    @Test
    fun `a tap on a field that is already focused counts too`() {
        appInFront = true
        learnKeyboard()
        val ahead = listOf(frame(null) { service.onAccessibilityEvent(field(type = AccessibilityEvent.TYPE_VIEW_CLICKED)) }) +
            (1 until 10).map { frame(null) }
        assertTrue("up ahead of the keyboard:\n" + describe(ahead, 0), ahead.all { settledAt(it, FRAME_TOP + 15) })
    }

    @Test
    fun `with no keyboard reported within 300 ms the pill shown ahead of it goes at once, and that field is not anticipated again`() {
        appInFront = true
        learnKeyboard()
        val looks = listOf(frame(null) { service.onAccessibilityEvent(field()) }) + (1..45).map { frame(null) }
        val gone = looks.indexOfFirst { it == null }
        assertEquals("on screen for 38 frames (the tap's and 300 ms after it):\n" + describe(looks, 34), 38, gone)
        assertTrue("fully there, at its spot, until then:\n" + describe(looks, 0), looks.take(gone).all { settledAt(it, FRAME_TOP + 15) })
        assertTrue("then gone for good, without a fade:\n" + describe(looks, gone - 2), looks.drop(gone).all { it == null })
        val again = listOf(frame(null) { service.onAccessibilityEvent(field()) }) + (1..45).map { frame(null) }
        assertTrue("that field brought no keyboard up, so it gets no pill ahead of one:\n" + describe(again, 0), again.all { it == null })
        assertTrue(KeyboardTimingLog.text(), "no keyboard came up for it last time" in KeyboardTimingLog.text())
    }

    @Test
    fun `a hardware keyboard attached takes the pill shown ahead of the keyboard at once`() {
        appInFront = true
        learnKeyboard()
        val looks = listOf(frame(null) { service.onAccessibilityEvent(field()) }) + (1..4).map { frame(null) } +
            listOf(frame(null) { attachHardwareKeyboard() }) + (1..10).map { frame(null) }
        assertTrue("up ahead of the keyboard:\n" + describe(looks, 0), looks.take(5).all { settledAt(it, FRAME_TOP + 15) })
        assertTrue("gone in the frame the keyboard was attached:\n" + describe(looks, 3), looks.drop(5).all { it == null })
    }

    /** A field event nothing should be shown ahead of, for [reason] (each case on a field of its own, so what one learns does not decide another). */
    private fun assertNothingAhead(reason: String, event: AccessibilityEvent) {
        val looks = listOf(frame(null) { service.onAccessibilityEvent(event) }) + (1..40).map { frame(null) }
        assertTrue("$reason: nothing shown:\n" + describe(looks, 0), looks.all { it == null })
        assertTrue("$reason: said why:\n" + KeyboardTimingLog.text(), reason in KeyboardTimingLog.text())
    }

    @Test
    fun `no pill ahead of the keyboard before its resting spot is known, for a field focused as its screen opens, just after the keyboard went away, or outside the app in front`() {
        appInFront = true
        selectKeyboard()
        assertNothingAhead("where $IME_PACKAGE rests on this screen is not known yet", field(viewId = "$APP_PACKAGE:id/unknown"))
        learnKeyboard()
        frame(null) { service.onAccessibilityEvent(windowStateChanged(APP_PACKAGE)) }
        assertNothingAhead("a field focused as its screen opens brings a keyboard up only in some apps", field(viewId = "$APP_PACKAGE:id/opening"))
        repeat(130) { frame(null) }
        assertNothingAhead("it is not in the app in front", field(viewId = "$APP_PACKAGE:id/behind", windowId = 99))
        open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP, frames = 40)
        frame(null, report = true)
        frame(null)
        assertNothingAhead("the keyboard went away 16ms before", field(viewId = "$APP_PACKAGE:id/settling"))
    }

    @Test
    fun `no pill ahead of the keyboard with a hardware keyboard attached or in keyboard mode`() {
        appInFront = true
        learnKeyboard()
        attachHardwareKeyboard()
        assertNothingAhead("a hardware keyboard is attached", field(viewId = "$APP_PACKAGE:id/hardware"))
        KeyboardPresence.get(RuntimeEnvironment.getApplication()).refresh(Configuration())
        SettingsStore.get(service).update {
            it.copy(keyboard = it.keyboard.copy(desktopOverlay = DesktopOverlay.ON, showOverlayWhenIdle = false))
        }
        repeat(5) { frame(null) }
        assertNothingAhead("keyboard mode", field(viewId = "$APP_PACKAGE:id/keyboard-mode"))
    }

    @Test
    fun `a field focused as its screen opens gets the pill ahead of the keyboard once a keyboard has come up for it that way`() {
        appInFront = true
        learnKeyboard()
        // The first time it waits for the keyboard, which comes, as it does for the app on Bennett's recording (E1).
        frame(null) { service.onAccessibilityEvent(windowStateChanged(APP_PACKAGE)) }
        val first = listOf(frame(null) { service.onAccessibilityEvent(field()) }) + (1 until 10).map { frame(null) }
        assertTrue("not shown ahead the first time:\n" + describe(first, 0), first.all { it == null })
        open(firstTop = 2250, restTop = FRAME_TOP + 15, frameTop = FRAME_TOP, frames = 40)
        closeKeyboard()
        repeat(130) { frame(null) }
        frame(null) { service.onAccessibilityEvent(windowStateChanged(APP_PACKAGE)) }
        val again = listOf(frame(null) { service.onAccessibilityEvent(field()) }) + (1 until 10).map { frame(null) }
        assertTrue("shown ahead of it from then on:\n" + describe(again, 0), again.all { settledAt(it, FRAME_TOP + 15) })
    }
}
