package app.murmur.android

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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
private const val KEYBOARD_TOP = 1500
private const val IME_WINDOW_ID = 7

/**
 * When the keyboard's window arrives or leaves, the accessibility service is told, and the pill
 * appears or goes. Bennett's recording has the pill still drawn 80-140 ms after the keyboard was
 * gone (frames 768-777, 1031-1048) and popping in 84 ms into the keyboard's slide at the height of
 * the keyboard's mid-animation position (frames 908-918, 1235-1239).
 *
 * This drives the real service the way Android does: [FrameworkDispatch] is the framework's side of
 * the delivery (AbstractAccessibilityServiceConnection.notifyAccessibilityEvent), which holds every
 * event for the service's configured notification timeout and restarts the wait when another event
 * of the same type comes in. A change in the set of windows (the keyboard's window appearing or
 * disappearing) is reported at once (AccessibilityWindowsPopulator), so any delay between the
 * keyboard and the pill beyond that is the service's own.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xxhdpi")
class KeyboardWindowTimingTest {

    /** The framework holding events for the service; [timeoutMs] is what the service asked for. */
    private class FrameworkDispatch(private val timeoutMs: Long, private val deliver: (AccessibilityEvent) -> Unit) {
        private val pending = HashMap<Int, Pair<AccessibilityEvent, Long>>()

        fun post(event: AccessibilityEvent, now: Long) {
            if (timeoutMs <= 0L) {
                deliver(event)
                return
            }
            pending[event.eventType] = event to now + timeoutMs
        }

        fun deliverDue(now: Long) {
            val due = pending.filterValues { it.second <= now }
            for ((type, entry) in due) {
                pending.remove(type)
                deliver(entry.first)
            }
        }
    }

    private lateinit var service: MurmurAccessibilityService
    private lateinit var dispatch: FrameworkDispatch
    private var now = 0L
    private val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)
    private val pixels = IntArray(SCREEN_W * SCREEN_H)
    private val spot = OverlayAnchor(0.5f, 25f)

    /** The notification timeout the service declares, read from its configuration the way the framework reads it. */
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
    }

    private fun imeWindow(visibleTop: Int, frameTop: Int = visibleTop): AccessibilityWindowInfo {
        val window = AccessibilityWindowInfo.obtain()
        shadowOf(window).apply {
            setType(AccessibilityWindowInfo.TYPE_INPUT_METHOD)
            setId(IME_WINDOW_ID)
            // What the window list reports is where SurfaceFlinger has the keyboard in that frame (mid-slide during an
            // animation); the keyboard's own views are laid out where it comes to rest.
            setBoundsInScreen(Rect(0, visibleTop, SCREEN_W, SCREEN_H))
            setRoot(AccessibilityNodeInfo.obtain().apply { setBoundsInScreen(Rect(0, frameTop, SCREEN_W, SCREEN_H)) })
        }
        return window
    }

    /** One frame: the keyboard as the window list now reports it (null: no keyboard), then whatever the framework delivers by the end of the frame. */
    private fun frame(ime: AccessibilityWindowInfo?, windowSetChanged: Boolean) {
        shadowOf(service).setWindows(listOfNotNull(ime))
        if (windowSetChanged) dispatch.post(AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOWS_CHANGED), now)
        dispatch.deliverDue(now)
        ShadowLooper.idleMainLooper()
        now += FRAME_MS
        ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
        dispatch.deliverDue(now)
        ShadowLooper.idleMainLooper()
    }

    private fun overlayViews(): List<View> =
        Shadow.extract<ShadowWindowManagerImpl>(service.getSystemService(WindowManager::class.java)).views

    private fun pillView(): OverlayPillView? = overlayViews().filterIsInstance<OverlayPillView>().singleOrNull()

    /** Centre of the opaque pill body as the canvas draws it (the pill is fully opaque; shadow and ghosts are not). */
    private fun drawnPill(view: OverlayPillView): Pair<Float, Float>? {
        bitmap.eraseColor(Color.TRANSPARENT)
        view.draw(canvas)
        bitmap.getPixels(pixels, 0, SCREEN_W, 0, 0, SCREEN_W, SCREEN_H)
        var left = Int.MAX_VALUE
        var top = Int.MAX_VALUE
        var right = Int.MIN_VALUE
        var bottom = Int.MIN_VALUE
        for (y in 0 until SCREEN_H) {
            val row = y * SCREEN_W
            for (x in 0 until SCREEN_W) {
                if (Color.alpha(pixels[row + x]) < 230) continue
                left = min(left, x)
                right = max(right, x)
                top = min(top, y)
                bottom = max(bottom, y)
            }
        }
        return if (right < left) null else (left + right + 1) / 2f to (top + bottom + 1) / 2f
    }

    private fun restingCenter(keyboardTop: Int): Pair<Float, Float> =
        OverlayGeometry.anchorPoint(spot, SCREEN_W.toFloat(), SCREEN_H.toFloat(), keyboardTop.toFloat(), DENSITY, 64 * DENSITY, 36 * DENSITY)

    /** Opens the keyboard with its window reported at once (first frame of the slide) and settled 12 frames later. */
    private fun openKeyboard(): Int {
        var appearedAt = -1
        frame(imeWindow(visibleTop = 2250, frameTop = KEYBOARD_TOP), windowSetChanged = true)
        if (pillView() != null) appearedAt = 0
        for (i in 1..12) {
            frame(imeWindow(visibleTop = KEYBOARD_TOP + (2250 - KEYBOARD_TOP) * (12 - i) / 12, frameTop = KEYBOARD_TOP), windowSetChanged = false)
            if (appearedAt < 0 && pillView() != null) appearedAt = i
        }
        // The window list settles 35 ms after the keyboard stops moving and reports its final bounds.
        repeat(5) { frame(imeWindow(KEYBOARD_TOP), windowSetChanged = false) }
        frame(imeWindow(KEYBOARD_TOP), windowSetChanged = true)
        repeat(4) { frame(imeWindow(KEYBOARD_TOP), windowSetChanged = false) }
        return appearedAt
    }

    @Test
    fun `the pill appears in the frame the keyboard's window arrives, where the keyboard comes to rest`() {
        frame(null, windowSetChanged = false)
        assertNull(pillView())
        frame(imeWindow(visibleTop = 2250, frameTop = KEYBOARD_TOP), windowSetChanged = true)
        val pill = pillView()
        assertNotNull("the keyboard's window arrived this frame; the pill must be up in it", pill)
        val shown = drawnPill(pill!!)
        val (ex, ey) = restingCenter(KEYBOARD_TOP)
        assertNotNull(shown)
        assertTrue("drawn at $shown; the keyboard rests at $KEYBOARD_TOP so the pill belongs at ($ex, $ey)",
            abs(shown!!.first - ex) < 1.5f && abs(shown.second - ey) < 1.5f)
    }

    @Test
    fun `the pill is gone in the frame the keyboard's window leaves`() {
        assertEquals(0, openKeyboard())
        assertNotNull(pillView())
        frame(null, windowSetChanged = true)
        assertNull("the keyboard's window left this frame; the pill must be gone in it", pillView())
        assertTrue(overlayViews().isEmpty())
    }

    @Test
    fun `the pill keeps no window on screen once the keyboard has gone, and comes back with it`() {
        assertEquals(0, openKeyboard())
        frame(null, windowSetChanged = true)
        repeat(10) { frame(null, windowSetChanged = false) }
        assertTrue(overlayViews().isEmpty())
        assertEquals(0, openKeyboard())
        val shown = drawnPill(pillView()!!)!!
        val (ex, ey) = restingCenter(KEYBOARD_TOP)
        assertTrue("back at $shown, expected ($ex, $ey)", abs(shown.first - ex) < 1.5f && abs(shown.second - ey) < 1.5f)
    }
}
