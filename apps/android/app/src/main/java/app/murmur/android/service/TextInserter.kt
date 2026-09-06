package app.murmur.android.service

import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import app.murmur.android.text.spliceAtSelection
import kotlinx.coroutines.delay

private const val TAG = "MurmurInsert"

/**
 * Chromium (Chrome, Samsung Internet, Edge, Brave, the system WebView, installed PWAs / WebAPKs)
 * tags every node of the virtual tree it builds for a page with the Blink role under this key.
 */
const val EXTRA_CHROME_ROLE = "AccessibilityNodeInfo.chromeRole"

/** Class name browser engines (Chromium, GeckoView) give the document root of web content. */
const val WEB_VIEW_CLASS_NAME = "android.webkit.WebView"

/** Web documents nest deeply; still cap the ancestor walk so a pathological tree cannot stall us. */
private const val MAX_ANCESTOR_WALK = 64

/**
 * Pause between the activation click and the paste into web content. Chromium answers the click as
 * soon as it has forwarded it to the renderer, where the frame is granted its user activation and
 * the field refocused; the paste reaches the renderer over a different pipe, so nothing orders the
 * two. Anything well inside the five-second activation window works; this also lets the page's own
 * blur/focus handlers finish before the paste lands, and is invisible next to the transcription.
 */
internal const val WEB_ACTIVATION_SETTLE_MS = 150L

/**
 * The slice of [AccessibilityNodeInfo] the insertion strategy needs. Kept behind an interface so
 * the exact action sequence the service sends can be exercised against a real `EditText` in unit
 * tests: `View.performAccessibilityAction` takes the same action ids and argument bundles.
 */
interface EditableTarget {
    /** Re-read the node from the app that owns it. False when the field is gone. */
    fun refresh(): Boolean
    val text: CharSequence?
    val isShowingHintText: Boolean
    val isPassword: Boolean
    val isEditable: Boolean

    /**
     * True when the field is web content rendered by a browser engine: a page in Chrome or Samsung
     * Internet, an installed PWA, or a WebView embedded in another app.
     */
    val isWebContent: Boolean
    val selectionStart: Int
    val selectionEnd: Int

    /** Whether the node lists [action] among the accessibility actions it supports. */
    fun supportsAction(action: Int): Boolean
    fun performAction(action: Int, arguments: Bundle?): Boolean
}

/** A field an accessibility service can write into: editable, or at least accepting SET_TEXT or PASTE. */
fun EditableTarget.acceptsText(): Boolean = canSetText() || canPaste()

fun EditableTarget.canSetText(): Boolean =
    isEditable || supportsAction(AccessibilityNodeInfo.ACTION_SET_TEXT)

fun EditableTarget.canPaste(): Boolean =
    isEditable || supportsAction(AccessibilityNodeInfo.ACTION_PASTE)

sealed class InsertOutcome {
    /** The dictation is in the field; [method] is `set-text` or `paste`. */
    data class Inserted(val method: String) : InsertOutcome()

    /** Nothing was written. The text is on the clipboard and [message] is what the pill shows. */
    data class Failed(val message: String) : InsertOutcome()
}

const val COPIED_NO_FIELD = "Copied — tap a text field and paste"
const val COPIED_FIELD_BLOCKED = "Copied — this field blocks insertion, paste manually"

/**
 * Puts dictated text into a focused field using accessibility actions.
 *
 * Native fields (`EditText`, Compose, Flutter, React Native) get the precise, clipboard-free
 * route: read the field, splice the dictation in at the selection, write the whole thing back with
 * `ACTION_SET_TEXT`, then move the caret to the end of the dictation with `ACTION_SET_SELECTION`.
 *
 * Web content is different. Chromium reports every text field of a page — `<input>`, `<textarea>`
 * and any `contenteditable` editor — as an editable `android.widget.EditText` and answers
 * `ACTION_SET_TEXT` with `true`, but implements it for `contenteditable` as `element.innerText =
 * value`: no `beforeinput` / `input` events, so the React / Draft.js / ProseMirror / Quill editors
 * behind Slack, Discord, WhatsApp Web, X, Notion and most PWAs never learn about the text and
 * either revert it on their next render or send an empty message. The `text` the node reports for
 * such editors is the concatenated subtree (placeholders included) and its selection offsets are
 * approximations, so splicing into it also puts the dictation in the wrong place. `ACTION_PASTE`,
 * on the other hand, runs the engine's own paste command and lands as a real user edit at the
 * caret, in every kind of field, so web content is pasted into first and `ACTION_SET_TEXT` is only
 * a fallback for engines that refuse to paste.
 *
 * Pasting into Chrome has one more requirement. Chrome only lets a page read the clipboard while
 * the page has *transient user activation*: a real gesture inside the page within the last five
 * seconds (`ChromeContentBrowserClient::IsClipboardPasteAllowed` → `HasTransientUserActivation`,
 * `kActivationLifespan`). Without it the renderer's clipboard read comes back empty, Blink pastes
 * an empty string, and Chrome still answers `ACTION_PASTE` with `true` because it only forwards the
 * command (`WebContentsAccessibilityImpl.performAction` → `WebContents.paste()`). Tapping the pill
 * happens in Murmur's own overlay window, not in the page, so the last in-page gesture is the tap
 * that focused the field: a short dictation squeezes inside the window, a long one — more speech,
 * transcription, the formatting pass — does not, and "Inserted" lands nothing. The fix is the same
 * thing a TalkBack double-tap does: `ACTION_CLICK` on the field, which Blink implements as
 * `NotifyUserActivation` followed by refocusing the field with its selection restored
 * (`AXObject::OnNativeClickAction`), so the caret does not move and the paste is allowed again.
 * The WebView uses the permissive default and never needed this; the click is harmless there.
 *
 * Password fields are always pasted into as well: their accessibility text is the masked rendering
 * and must never be written back. Fields that refuse `ACTION_SET_TEXT` (some rich editors) fall
 * back to the clipboard too.
 *
 * Never send `ACTION_SET_TEXT` without `ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE`: `TextView` treats a
 * missing argument as `setText(null)` and empties the field, which is exactly how the dictation used
 * to vanish right after it appeared.
 */
object TextInserter {
    suspend fun insert(
        target: EditableTarget,
        text: String,
        pressEnter: Boolean,
        toClipboard: (String) -> Unit
    ): InsertOutcome {
        // A node that cannot be refreshed belongs to a field that is gone (or an app that stopped
        // answering); acting on the cached copy would only fail later with a misleading message.
        if (!target.refresh() || !target.acceptsText()) {
            toClipboard(text)
            return InsertOutcome.Failed(COPIED_NO_FIELD)
        }

        val method = when {
            target.isPassword -> if (paste(target, text, toClipboard)) "paste" else null
            target.isWebContent || !target.canSetText() -> when {
                paste(target, text, toClipboard) -> "paste"
                target.canSetText() && setText(target, text) -> {
                    Log.i(TAG, "engine refused ACTION_PASTE; ACTION_SET_TEXT accepted")
                    "set-text"
                }
                else -> null
            }
            else -> when {
                setText(target, text) -> "set-text"
                paste(target, text, toClipboard) -> {
                    Log.i(TAG, "field refused ACTION_SET_TEXT; pasted instead")
                    "paste"
                }
                else -> null
            }
        } ?: return InsertOutcome.Failed(COPIED_FIELD_BLOCKED)

        if (pressEnter && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            target.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id, null)
        }
        return InsertOutcome.Inserted(method)
    }

    private fun setText(target: EditableTarget, text: String): Boolean {
        val existing = if (target.isShowingHintText) "" else target.text?.toString() ?: ""
        val splice = spliceAtSelection(existing, target.selectionStart, target.selectionEnd, text)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, splice.text)
        }
        if (!target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return false
        // SET_TEXT parks the caret at the very end of the field. When the dictation went into the
        // middle of existing text, bring the caret back to just after it.
        if (splice.caret != splice.text.length) {
            val sel = Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, splice.caret)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, splice.caret)
            }
            if (!target.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)) {
                Log.w(TAG, "field ignored ACTION_SET_SELECTION; caret stays at the end")
            }
        }
        return true
    }

    private suspend fun paste(target: EditableTarget, text: String, toClipboard: (String) -> Unit): Boolean {
        // Clipboard first: the engine hears about the new clip through an asynchronous listener,
        // and everything that follows gives that notification time to arrive before the paste reads.
        toClipboard(text)
        if (target.isWebContent) activateWebContent(target)
        return target.performAction(AccessibilityNodeInfo.ACTION_PASTE, null)
    }

    /**
     * Hand the page a fresh user activation so Chrome lets the paste read the clipboard (see the
     * class comment). Best effort: a refused click is logged and the paste still goes ahead, since
     * the field may have been tapped recently enough anyway.
     */
    private suspend fun activateWebContent(target: EditableTarget) {
        if (!target.performAction(AccessibilityNodeInfo.ACTION_CLICK, null)) {
            Log.w(TAG, "web content refused ACTION_CLICK; pasting without fresh user activation")
            return
        }
        delay(WEB_ACTIVATION_SETTLE_MS)
    }
}

/**
 * Run [lookup] until it yields a value, at most [attempts] times with [delayMs] between attempts;
 * `null` once every attempt came back empty. The service uses this to give a page's accessibility
 * tree a moment to appear before declaring that no field is focused.
 */
suspend fun <T : Any> retryLookup(attempts: Int, delayMs: Long, lookup: (attempt: Int) -> T?): T? {
    repeat(attempts) { attempt ->
        lookup(attempt)?.let { return it }
        if (attempt < attempts - 1) delay(delayMs)
    }
    return null
}

/** Whether the node lists [action] among the actions it supports. */
fun AccessibilityNodeInfo.supportsAction(action: Int): Boolean =
    runCatching { actionList.any { it.id == action } }.getOrDefault(false)

/** A node an accessibility service can put text into. Mirrors [EditableTarget.acceptsText]. */
fun AccessibilityNodeInfo.acceptsText(): Boolean =
    isEditable ||
        supportsAction(AccessibilityNodeInfo.ACTION_SET_TEXT) ||
        supportsAction(AccessibilityNodeInfo.ACTION_PASTE)

/**
 * Whether this node is web content: part of the virtual tree a browser engine builds for a page.
 * Chromium marks each of its nodes with [EXTRA_CHROME_ROLE]; other engines are recognised by the
 * `android.webkit.WebView` document root above the field.
 */
fun AccessibilityNodeInfo.isWebContent(): Boolean {
    if (runCatching { extras.containsKey(EXTRA_CHROME_ROLE) }.getOrDefault(false)) return true
    var ancestor = runCatching { parent }.getOrNull()
    var depth = 0
    while (ancestor != null && depth < MAX_ANCESTOR_WALK) {
        if (ancestor.className?.toString() == WEB_VIEW_CLASS_NAME) return true
        ancestor = runCatching { ancestor.parent }.getOrNull()
        depth++
    }
    return false
}

/** [EditableTarget] over a live accessibility node. */
class NodeTarget(private val node: AccessibilityNodeInfo) : EditableTarget {
    override fun refresh(): Boolean = runCatching { node.refresh() }.getOrDefault(false)
    override val text: CharSequence? get() = node.text
    override val isShowingHintText: Boolean get() = node.isShowingHintText
    override val isPassword: Boolean get() = node.isPassword
    override val isEditable: Boolean get() = node.isEditable
    // Each step up the tree is a binder round trip into the app; the answer cannot change while
    // one dictation is being inserted, so look it up once.
    override val isWebContent: Boolean by lazy { node.isWebContent() }
    override val selectionStart: Int get() = node.textSelectionStart
    override val selectionEnd: Int get() = node.textSelectionEnd
    override fun supportsAction(action: Int): Boolean = node.supportsAction(action)
    override fun performAction(action: Int, arguments: Bundle?): Boolean =
        runCatching { node.performAction(action, arguments) }.getOrDefault(false)
}
