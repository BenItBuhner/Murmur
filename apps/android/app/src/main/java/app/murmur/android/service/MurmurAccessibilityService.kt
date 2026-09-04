package app.murmur.android.service

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.OverlayPillView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

private const val TAG = "MurmurA11y"

/**
 * The Wispr Flow pattern on Android: whenever the keyboard comes up, a floating dictation
 * pill appears just above it. Tap to dictate, tap again to stop; the transcribed, cleaned
 * text is inserted into the focused text field via accessibility actions.
 *
 * This service is also the injection backend ("TextSink"): ACTION_SET_TEXT at the cursor,
 * with a clipboard fallback when a field refuses direct writes.
 */
class MurmurAccessibilityService : AccessibilityService(), app.murmur.android.dictation.TextSink {

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
