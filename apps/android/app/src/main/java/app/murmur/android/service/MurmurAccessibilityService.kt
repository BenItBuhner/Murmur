package app.murmur.android.service

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
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
import kotlin.math.max
import kotlin.math.roundToInt

private const val TAG = "MurmurA11y"

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
 * This service is also the injection backend ("TextSink"): ACTION_SET_TEXT at the cursor,
 * with a clipboard fallback when a field refuses direct writes.
 */
class MurmurAccessibilityService : AccessibilityService(), app.murmur.android.dictation.TextSink, OverlayPillView.Host {

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
                if (source.isEditable) {
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

    override fun insert(text: String, pressEnter: Boolean): String? {
        var node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (node == null || !node.isEditable) {
            node = lastEditable?.takeIf {
                runCatching { it.refresh() }.getOrDefault(false) && it.isEditable
            }
        }
        if (node == null) {
            copyToClipboard(text)
            return "Copied — tap a text field and paste"
        }

        val existing = if (node.isShowingHintText) "" else node.text?.toString() ?: ""
        var selStart = node.textSelectionStart
        var selEnd = node.textSelectionEnd
        if (selStart < 0 || selStart > existing.length) selStart = existing.length
        if (selEnd < 0 || selEnd > existing.length) selEnd = selStart
        if (selEnd < selStart) selStart = selEnd.also { selEnd = selStart }

        val newText = existing.substring(0, selStart) + text + existing.substring(selEnd)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, newText)
        }
        var ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        if (ok) {
            val cursor = selStart + text.length
            val sel = Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
            }
            node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, sel)
        } else {
            // Some fields (rich editors, web views) refuse SET_TEXT; paste instead.
            copyToClipboard(text)
            ok = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            if (!ok) return "Copied — this field blocks insertion, paste manually"
        }
        if (pressEnter && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        }
        return null
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
