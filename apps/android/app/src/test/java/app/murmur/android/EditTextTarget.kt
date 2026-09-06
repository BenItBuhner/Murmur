package app.murmur.android

import android.os.Bundle
import android.text.method.PasswordTransformationMethod
import android.widget.EditText
import app.murmur.android.service.EditableTarget

/**
 * [EditableTarget] over a real `EditText` for Robolectric tests. State is read the way
 * `TextView.onInitializeAccessibilityNodeInfo` reports it (the hint doubles as the text while the
 * field is empty) and actions go through `View.performAccessibilityAction`, the framework entry
 * point an accessibility service's `AccessibilityNodeInfo.performAction` ends up in.
 *
 * A plain native field: not web content, and editability is carried by [isEditable] alone (tests
 * that model fields advertising individual actions override [supportsAction]).
 */
open class EditTextTarget(val view: EditText) : EditableTarget {
    override fun refresh(): Boolean = true
    override val text: CharSequence?
        get() = if (view.text.isNullOrEmpty()) view.hint else view.text
    override val isShowingHintText: Boolean
        get() = view.text.isNullOrEmpty() && !view.hint.isNullOrEmpty()
    override val isPassword: Boolean
        get() = view.transformationMethod is PasswordTransformationMethod
    override val isEditable: Boolean get() = true
    override val isWebContent: Boolean get() = false
    override val selectionStart: Int get() = view.selectionStart
    override val selectionEnd: Int get() = view.selectionEnd
    override fun supportsAction(action: Int): Boolean = false
    override fun performAction(action: Int, arguments: Bundle?): Boolean =
        view.performAccessibilityAction(action, arguments)
}
