package app.murmur.android.service

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.dictation.TextSink
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayEditor
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.overlay.overlayAnchor
import app.murmur.android.settings.SettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.roundToInt

private const val TAG = "MurmurA11y"

/**
 * How long to keep looking for the focused field before giving up. Chromium hands the framework no
 * node provider for a page until the renderer has delivered the accessibility tree, which it only
 * builds once something asks for it, so the first lookup into a PWA or browser tab that just came to
 * the front can come back empty while a field is plainly focused; One UI likewise reports no active
 * window for a moment after an overlay was touched. A few short retries cover both.
 */
private const val TARGET_LOOKUP_ATTEMPTS = 5
private const val TARGET_LOOKUP_RETRY_MS = 90L

/**
 * The Wispr Flow pattern on Android: whenever the keyboard comes up, a floating dictation
 * button appears next to it (by default centred just above it; the user can park it anywhere,
 * including on the keyboard's own toolbar). Tap to dictate, tap again to stop; the transcribed,
 * cleaned text is inserted into the focused text field via accessibility actions.
 *
 * The pill view owns its geometry and animations and asks this service (its [OverlayPillView.Host])
 * to move or resize the overlay window; that only happens before a morph starts and after it
 * settles, never frame by frame.
 *
 * This service is also the injection backend ([TextSink]); see [TextInserter] for the
 * ACTION_SET_TEXT / ACTION_SET_SELECTION / ACTION_PASTE strategy.
 */
class MurmurAccessibilityService : AccessibilityService(), TextSink, OverlayPillView.Host {

    private var windowManager: WindowManager? = null
    private var pill: OverlayPillView? = null
    private var pillParams: WindowManager.LayoutParams? = null
    private var pillAttached = false
    private var keyboardVisible = false

    /** Top edge of the keyboard the last time it was on screen; kept while a dictation is in flight. */
    private var keyboardTop = -1
    private var lastEditable: AccessibilityNodeInfo? = null
    private var lastPackage: String = ""
    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        DictationController.sink = this
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val settings = SettingsStore.get(this)
        mainScope.launch {
            DictationController.state.collect { state ->
                pill?.render(state)
                // Keep the pill on screen while a dictation is in flight even if the
                // keyboard gets dismissed underneath it.
                if (state !is DictationState.Idle) showPill() else syncPillVisibility()
            }
        }
        mainScope.launch {
            settings.flow.collect { s -> pill?.configure(s.overlayShape, s.overlayAnchor()) }
        }
        mainScope.launch {
            OverlayEditor.editing.collect { editing ->
                if (editing) showPill()
                pill?.setEditing(editing)
                syncPillVisibility()
            }
        }
        Log.i(TAG, "accessibility service connected")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        if (DictationController.sink === this) DictationController.sink = null
        OverlayEditor.stop()
        removePill()
        mainScope.cancel()
        super.onDestroy()
    }

    override fun onInterrupt() = Unit

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED -> {
                val source = event.source ?: return
                if (source.acceptsText()) {
                    lastEditable = source
                    lastPackage = event.packageName?.toString() ?: lastPackage
                }
                updateKeyboardState()
            }
            AccessibilityEvent.TYPE_WINDOWS_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> updateKeyboardState()
        }
    }

    // ---- keyboard tracking ----------------------------------------------------------------

    private fun updateKeyboardState() {
        var visible = false
        var top = -1
        try {
            for (w in windows) {
                if (w.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
                    val bounds = Rect()
                    w.getBoundsInScreen(bounds)
                    // Some keyboards keep a zero-height window alive while hidden.
                    if (bounds.height() > 80) {
                        visible = true
                        top = bounds.top
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "window scan failed", e)
        }
        keyboardVisible = visible
        if (visible) keyboardTop = top
        syncPillVisibility()
    }

    private fun syncPillVisibility() {
        val busy = DictationController.state.value !is DictationState.Idle
        if (keyboardVisible || busy || OverlayEditor.editing.value) showPill() else removePill()
    }

    /** Where the pill measures its vertical offset from: the keyboard's top edge, or the last known one while busy. */
    private fun keyboardReference(): Int? {
        if (keyboardVisible) return keyboardTop
        val busy = DictationController.state.value !is DictationState.Idle || OverlayEditor.editing.value
        return if (busy && keyboardTop > 0) keyboardTop else null
    }

    private fun showPill() {
        if (windowManager == null) return
        val (screenW, screenH) = screenSize()
        val existing = pill
        if (existing != null) {
            existing.setScreen(screenW, screenH, keyboardReference())
            return
        }
        val settings = SettingsStore.get(this)
        val view = OverlayPillView(this).apply {
            host = this@MurmurAccessibilityService
            onMicTap = { DictationController.toggle(this@MurmurAccessibilityService) }
            onCancelTap = { DictationController.cancel(this@MurmurAccessibilityService) }
            onConfirmTap = { DictationController.stopAndInsert(this@MurmurAccessibilityService) }
            onAnchorChanged = { a -> settings.update { it.copy(overlayAnchorX = a.xFraction, overlayOffsetDp = a.offsetDp) } }
            onEditDone = { OverlayEditor.stop() }
            onEditReset = {
                settings.update { it.copy(overlayAnchorX = OverlayAnchor.DEFAULT.xFraction, overlayOffsetDp = OverlayAnchor.DEFAULT.offsetDp) }
            }
        }
        val params = WindowManager.LayoutParams(
            1,
            1,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 0
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        pill = view
        pillParams = params
        pillAttached = false
        val s = settings.get()
        view.configure(s.overlayShape, s.overlayAnchor())
        view.setEditing(OverlayEditor.editing.value)
        // Computes the first window frame and, through applyWindowFrame, adds the window.
        view.setScreen(screenW, screenH, keyboardReference())
        view.render(DictationController.state.value)
        if (!pillAttached) removePill()
    }

    override fun applyWindowFrame(frame: Box) {
        val wm = windowManager ?: return
        val view = pill ?: return
        val params = pillParams ?: return
        params.x = frame.left.roundToInt()
        params.y = frame.top.roundToInt()
        params.width = max(1, frame.width.roundToInt())
        params.height = max(1, frame.height.roundToInt())
        try {
            if (!pillAttached) {
                wm.addView(view, params)
                pillAttached = true
            } else {
                wm.updateViewLayout(view, params)
            }
        } catch (e: Exception) {
            Log.e(TAG, "failed to place overlay", e)
        }
    }

    private fun removePill() {
        val wm = windowManager ?: return
        pill?.let {
            if (pillAttached) {
                try {
                    wm.removeView(it)
                } catch (_: Exception) {
                }
            }
        }
        pill = null
        pillParams = null
        pillAttached = false
    }

    private fun screenSize(): Pair<Int, Int> {
        val wm = windowManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && wm != null) {
            val bounds = wm.currentWindowMetrics.bounds
            return bounds.width() to bounds.height()
        }
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm?.defaultDisplay?.getRealMetrics(metrics)
        if (metrics.widthPixels <= 0 || metrics.heightPixels <= 0) {
            val dm = resources.displayMetrics
            return dm.widthPixels to dm.heightPixels
        }
        return metrics.widthPixels to metrics.heightPixels
    }

    // ---- TextSink ---------------------------------------------------------------------------

    override fun focusedPackage(): String {
        val root = rootInActiveWindow
        return root?.packageName?.toString() ?: lastPackage
    }

    /**
     * Accessibility node calls are plain binder IPC and work from any thread, but the framework
     * caches node state per thread and same-process interrogation (our own test pad) is only
     * short-circuited on the main thread, so the whole insertion runs there.
     */
    override suspend fun insert(text: String, pressEnter: Boolean): String? =
        withContext(Dispatchers.Main.immediate) {
            val node = awaitEditableTarget()
            if (node == null) {
                Log.w(TAG, "no focused editable field; copied to clipboard")
                copyToClipboard(text)
                return@withContext COPIED_NO_FIELD
            }
            val target = NodeTarget(node)
            when (val outcome = TextInserter.insert(target, text, pressEnter, ::copyToClipboard)) {
                is InsertOutcome.Inserted -> {
                    Log.i(
                        TAG,
                        "inserted ${text.length} chars via ${outcome.method} into ${node.packageName}" +
                            if (target.isWebContent) " (web content)" else ""
                    )
                    null
                }
                is InsertOutcome.Failed -> {
                    Log.w(TAG, "insertion failed: ${outcome.message}")
                    outcome.message
                }
            }
        }

    private suspend fun awaitEditableTarget(): AccessibilityNodeInfo? =
        retryLookup(TARGET_LOOKUP_ATTEMPTS, TARGET_LOOKUP_RETRY_MS) { attempt ->
            findEditableTarget().also {
                if (it == null && attempt < TARGET_LOOKUP_ATTEMPTS - 1) {
                    Log.d(TAG, "no focused field yet (attempt ${attempt + 1}); retrying")
                }
            }
        }

    /**
     * The field the dictation belongs in. The input-focused node of the active window is the
     * normal answer; when the system has no active window for a moment (One UI does this right
     * after an overlay was touched) every application window is checked, and the field that most
     * recently reported focus is the last resort, provided it belongs to the app in front: a
     * remembered field from an app that is still alive in the background must not swallow a
     * dictation meant for the one the user is looking at.
     */
    private fun findEditableTarget(): AccessibilityNodeInfo? {
        focusedEditable(rootInActiveWindow)?.let { return it }
        val visible = try {
            windows
        } catch (e: Exception) {
            Log.w(TAG, "window scan failed", e)
            emptyList()
        }
        // Windows come top-most first; the focused application window, or failing that the one on
        // top, is the app the user is looking at. (The active window itself may be the keyboard.)
        var frontPackage: String? = null
        for (w in visible.sortedByDescending { it.isFocused }) {
            if (w.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
            val root = runCatching { w.root }.getOrNull() ?: continue
            if (frontPackage == null) frontPackage = root.packageName?.toString()
            focusedEditable(root)?.let { return it }
        }
        val remembered = lastEditable ?: return null
        if (!runCatching { remembered.refresh() }.getOrDefault(false) || !remembered.acceptsText()) return null
        val rememberedPackage = remembered.packageName?.toString()
        if (frontPackage != null && rememberedPackage != frontPackage) {
            Log.d(TAG, "ignoring remembered field of $rememberedPackage; $frontPackage is in front")
            return null
        }
        return remembered
    }

    private fun focusedEditable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        val focus = runCatching { root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull() ?: return null
        return if (focus.acceptsText()) focus else null
    }

    private fun copyToClipboard(text: String) {
        val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Murmur dictation", text))
    }

    companion object {
        @Volatile
        var instance: MurmurAccessibilityService? = null
            private set

        val isRunning: Boolean get() = instance != null
    }
}
