package app.murmur.android.dictation

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * How a dictation was started, in the desktop app's terms (`DictationMode` in shared/types.ts):
 * a key held down for as long as the user speaks, a session that runs until it is stopped (the
 * floating button, a tap of the shortcut, the hands-free shortcut), or a spoken instruction that
 * edits the selected text in place.
 */
@Serializable
enum class DictationMode(val id: String) {
    @SerialName("hold") HOLD("hold"),
    @SerialName("hands-free") HANDS_FREE("hands-free"),
    @SerialName("command") COMMAND("command")
}
