package app.murmur.android.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.InputMethod
import android.os.Build
import android.os.SystemClock
import android.text.InputType
import android.util.Log
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import androidx.annotation.RequiresApi

private const val TAG = "MurmurKeyboard"

/**
 * The Android 13+ (API 33) accessibility-service input-method path, kept in its own file so nothing
 * here loads on older platforms: [MurmurAccessibilityService] only calls [accessibilityKeyboard]
 * behind an SDK check, so the API-33 types below are never resolved on Android 12 and earlier.
 *
 * With `flagInputMethodEditor` declared on the service, [AccessibilityService.getInputMethod]
 * hands back a connection to whichever editor currently has IME focus — the very same
 * `InputConnection` the soft keyboard talks to. That reaches editors a terminal emulator builds
 * from a custom `View` (`onCreateInputConnection` returns a connection, but no editable
 * accessibility node is ever exposed), which is exactly where `ACTION_SET_TEXT` / `ACTION_PASTE`
 * have nothing to act on.
 */

/**
 * Resolve keyboard support for the current dictation.
 *
 * When [settingOn] is false we still peek at whether an editor is connected, so the failure notice
 * can tell a terminal ("turn on keyboard support") apart from nothing being focused. When it is on,
 * a missing connection means the input-method flag has not taken effect yet (the service needs
 * re-enabling), which the [KeyboardStatus.NO_CONNECTION] notice explains.
 */
@RequiresApi(Build.VERSION_CODES.TIRAMISU)
internal fun accessibilityKeyboard(
    service: AccessibilityService,
    settingOn: Boolean,
): Pair<KeyboardInput?, KeyboardStatus> {
    val inputMethod = runCatching { service.inputMethod }.getOrNull()
    val connection = runCatching { inputMethod?.currentInputConnection }.getOrNull()
    if (!settingOn) {
        return null to if (connection != null) KeyboardStatus.OFF_BUT_EDITOR_PRESENT else KeyboardStatus.OFF
    }
    if (inputMethod == null || connection == null) return null to KeyboardStatus.NO_CONNECTION
    val editorInfo = runCatching { inputMethod.currentInputEditorInfo }.getOrNull()
    return AccessibilityInputMethodInput(connection, editorInfo) to KeyboardStatus.AVAILABLE
}

/** [KeyboardInput] over a live [InputMethod.AccessibilityInputConnection]. */
@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private class AccessibilityInputMethodInput(
    private val connection: InputMethod.AccessibilityInputConnection,
    editorInfo: EditorInfo?,
) : KeyboardInput {

    /**
     * TYPE_NULL editors (terminals) want the key stream, not composed text. The whole `inputType` is
     * zero for TYPE_NULL, so compare the value directly.
     */
    override val prefersKeyEvents: Boolean =
        editorInfo != null && editorInfo.inputType == InputType.TYPE_NULL

    override fun commitText(text: String): Boolean =
        runCatching { connection.commitText(text, 1, null) }.isSuccess

    override fun sendTextAsKeyEvents(text: String): Boolean = runCatching {
        typeAsKeys(
            text,
            VirtualKeyMap(),
            sendKey = { connection.sendKeyEvent(it) },
            commit = {
                Log.i(TAG, "no plain key for ${it.length} char(s); committing them through the input connection")
                connection.commitText(it, 1, null)
            },
        )
    }.isSuccess

    override fun pressEnter(): Boolean = runCatching {
        val now = SystemClock.uptimeMillis()
        connection.sendKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0))
        connection.sendKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0))
    }.isSuccess
}
