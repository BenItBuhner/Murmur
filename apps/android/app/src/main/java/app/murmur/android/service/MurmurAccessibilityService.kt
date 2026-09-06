package app.murmur.android.service

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.PixelFormat
import android.graphics.Rect
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.dictation.TextSink
import app.murmur.android.overlay.OverlayPillView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "MurmurA11y"

/**
 * The Wispr Flow pattern on Android: whenever the keyboard comes up, a floating dictation
 * pill appears just above it. Tap to dictate, tap again to stop; the transcribed, cleaned
 * text is inserted into the focused text field via accessibility actions.
 *
 * This service is also the injection backend ([TextSink]); see [TextInserter] for the
 * ACTION_SET_TEXT / ACTION_SET_SELECTION / ACTION_PASTE strategy.
 */
class MurmurAccessibilityService : AccessibilityService(), TextSink {

    private var windowManager: WindowManager? = null
    private var pill: OverlayPillView? = null
    private var pillParams: WindowManager.LayoutParams? = null
    private var pillVisible = false
    private var keyboardVisible = false
    private var keyboardTop = -1
    private var lastEditable: AccessibilityNodeInfo? = null
    private var lastPackage: String = ""
    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        DictationController.sink = this
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        mainScope.launch {
            DictationController.state.collect { state ->
                pill?.render(state)
                // Keep the pill on screen while a dictation is in flight even if the
                // keyboard gets dismissed underneath it.
                if (state !is DictationState.Idle) showPill() else syncPillVisibility()
            }
        }
        Log.i(TAG, "accessibility service connected")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        if (DictationController.sink === this) DictationController.sink = null
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
        keyboardTop = top
        syncPillVisibility()
    }

    private fun syncPillVisibility() {
        val busy = DictationController.state.value !is DictationState.Idle
        if (keyboardVisible || busy) showPill() else removePill()
    }

    private fun showPill() {
        val wm = windowManager ?: return
        val metrics = resources.displayMetrics
        val bottomOffset = if (keyboardTop > 0) {
            (metrics.heightPixels - keyboardTop + dp(12)).coerceIn(dp(12), metrics.heightPixels - dp(80))
        } else dp(96)

        if (pill == null) {
            val view = OverlayPillView(this).apply {
                onMicTap = { DictationController.toggle(this@MurmurAccessibilityService) }
                onCancelTap = { DictationController.cancel(this@MurmurAccessibilityService) }
                onConfirmTap = { DictationController.stopAndInsert(this@MurmurAccessibilityService) }
            }
            val params = WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                y = bottomOffset
            }
            try {
                wm.addView(view, params)
                pill = view
                pillParams = params
                pillVisible = true
                view.render(DictationController.state.value)
            } catch (e: Exception) {
                Log.e(TAG, "failed to add overlay", e)
            }
        } else if (pillParams?.y != bottomOffset) {
            pillParams?.y = bottomOffset
            try {
                wm.updateViewLayout(pill, pillParams)
            } catch (e: Exception) {
                Log.w(TAG, "failed to move overlay", e)
            }
        }
    }

    private fun removePill() {
        val wm = windowManager ?: return
        pill?.let {
            try {
                wm.removeView(it)
            } catch (_: Exception) {
            }
        }
        pill = null
        pillParams = null
        pillVisible = false
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

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
            val node = findEditableTarget()
            if (node == null) {
                Log.w(TAG, "no focused editable field; copied to clipboard")
                copyToClipboard(text)
                return@withContext COPIED_NO_FIELD
            }
            when (val outcome = TextInserter.insert(NodeTarget(node), text, pressEnter, ::copyToClipboard)) {
                is InsertOutcome.Inserted -> {
                    Log.i(TAG, "inserted ${text.length} chars via ${outcome.method} into ${node.packageName}")
                    null
                }
                is InsertOutcome.Failed -> {
                    Log.w(TAG, "insertion failed: ${outcome.message}")
                    outcome.message
                }
            }
        }

    /**
     * The field the dictation belongs in. The input-focused node of the active window is the
     * normal answer; when the system has no active window for a moment (One UI does this right
     * after an overlay was touched) every application window is checked, and the field that most
     * recently reported focus is the last resort.
     */
    private fun findEditableTarget(): AccessibilityNodeInfo? {
        focusedEditable(rootInActiveWindow)?.let { return it }
        val visible = try {
            windows
        } catch (e: Exception) {
            Log.w(TAG, "window scan failed", e)
            emptyList()
        }
        for (w in visible.sortedByDescending { it.isFocused }) {
            if (w.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
            focusedEditable(runCatching { w.root }.getOrNull())?.let { return it }
        }
        return lastEditable?.takeIf { runCatching { it.refresh() }.getOrDefault(false) && it.isEditable }
    }

    private fun focusedEditable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        val focus = runCatching { root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull() ?: return null
        return if (focus.isEditable) focus else null
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
