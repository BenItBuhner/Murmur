package app.murmur.android

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayGeometry
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.service.MurmurAccessibilityService
import app.murmur.android.settings.DesktopOverlay
import app.murmur.android.settings.OverlayShape
import app.murmur.android.settings.SettingsStore
import org.junit.After
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
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
        ShadowLooper.idleMainLooper()
        dispatch = FrameworkDispatch(declaredNotificationTimeout()) { service.onAccessibilityEvent(it) }
    }

    @After
    fun tearDown() {
        service.onDestroy()
        ShadowChoreographer.setPaused(false)
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
        shadowOf(service).setWindows(listOfNotNull(keyboard, navBar().takeIf { keyboard != null }))
        before()
        if (report) dispatch.post(AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOWS_CHANGED), now)
        dispatch.deliverDue(now)
        ShadowLooper.idleMainLooper()
        return pillLook()
    }

    private fun overlayViews(): List<View> =
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
}
