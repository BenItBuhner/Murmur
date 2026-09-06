package app.murmur.android.service

import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import app.murmur.android.text.spliceAtSelection

private const val TAG = "MurmurInsert"

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
    val selectionStart: Int
    val selectionEnd: Int
    fun performAction(action: Int, arguments: Bundle?): Boolean
}

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
 * Strategy: read the field, splice the dictation in at the selection and write the whole thing
 * back with `ACTION_SET_TEXT`, then move the caret to the end of the dictation with
 * `ACTION_SET_SELECTION`. Fields that refuse `ACTION_SET_TEXT` (web views, some rich editors) and
 * password fields (whose accessibility text is the masked rendering, never write that back) get
 * the text through the clipboard and `ACTION_PASTE`, which inserts at the caret without needing to
 * read the field at all.
 *
 * Never send `ACTION_SET_TEXT` without `ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE`: `TextView` treats a
 * missing argument as `setText(null)` and empties the field, which is exactly how the dictation used
 * to vanish right after it appeared.
 */
object TextInserter {
    fun insert(
        target: EditableTarget,
        text: String,
        pressEnter: Boolean,
        toClipboard: (String) -> Unit
    ): InsertOutcome {
        // A node that cannot be refreshed belongs to a field that is gone (or an app that stopped
        // answering); acting on the cached copy would only fail later with a misleading message.
        if (!target.refresh() || !target.isEditable) {
            toClipboard(text)
            return InsertOutcome.Failed(COPIED_NO_FIELD)
        }

        val method = if (target.isPassword) {
            if (!paste(target, text, toClipboard)) return InsertOutcome.Failed(COPIED_FIELD_BLOCKED)
            "paste"
        } else {
            val existing = if (target.isShowingHintText) "" else target.text?.toString() ?: ""
            val splice = spliceAtSelection(existing, target.selectionStart, target.selectionEnd, text)
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, splice.text)
            }
            if (target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                // SET_TEXT parks the caret at the very end of the field. When the dictation went into
                // the middle of existing text, bring the caret back to just after it.
                if (splice.caret != splice.text.length) {
                    val sel = Bundle().apply {
                        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, splice.caret)
                        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, splice.caret)
                    }
                    if (!target.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)) {
                        Log.w(TAG, "field ignored ACTION_SET_SELECTION; caret stays at the end")
                    }
                }
                "set-text"
            } else {
                Log.i(TAG, "field refused ACTION_SET_TEXT; falling back to paste")
                if (!paste(target, text, toClipboard)) return InsertOutcome.Failed(COPIED_FIELD_BLOCKED)
                "paste"
            }
        }

        if (pressEnter && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            target.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id, null)
        }
        return InsertOutcome.Inserted(method)
    }

    private fun paste(target: EditableTarget, text: String, toClipboard: (String) -> Unit): Boolean {
        toClipboard(text)
        return target.performAction(AccessibilityNodeInfo.ACTION_PASTE, null)
    }
}

/** [EditableTarget] over a live accessibility node. */
class NodeTarget(private val node: AccessibilityNodeInfo) : EditableTarget {
    override fun refresh(): Boolean = runCatching { node.refresh() }.getOrDefault(false)
    override val text: CharSequence? get() = node.text
    override val isShowingHintText: Boolean get() = node.isShowingHintText
    override val isPassword: Boolean get() = node.isPassword
    override val isEditable: Boolean get() = node.isEditable
    override val selectionStart: Int get() = node.textSelectionStart
    override val selectionEnd: Int get() = node.textSelectionEnd
    override fun performAction(action: Int, arguments: Bundle?): Boolean =
        runCatching { node.performAction(action, arguments) }.getOrDefault(false)
}
