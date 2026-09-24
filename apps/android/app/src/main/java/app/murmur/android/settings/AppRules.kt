package app.murmur.android.settings

import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * A per-app override, matched on the package name or launcher label of the app that owns the
 * focused field (the desktop matches the window title or process name the same way). Everything
 * the destination needs beyond this the engine derives from the app category itself, so a rule
 * only carries what a person would actually want to say about an app: how it should sound,
 * whether to format at all, and any extra guidance for the model. Same shape as the desktop app's
 * `appRuleSchema` and the backend's `appRules` records; a rule synced from the account drops in.
 */
@Serializable
data class AppRule(
    val id: String,
    val match: String,
    val tone: Tone = Tone.AUTO,
    /** Overrides the global formatting mode in this app; null follows the global setting. */
    val formatting: FormattingMode? = null,
    val trailingSpace: Boolean? = null,
    /** Extra guidance for the model in this app only; appended to the global instructions. */
    val instructions: String? = null,
    val createdAt: Long = 0L
)

object AppRuleCodec {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun encode(rules: List<AppRule>): String = json.encodeToString(rules)

    fun decode(raw: String?): List<AppRule> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            json.decodeFromString<List<AppRule>>(raw)
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun newRule(match: String = ""): AppRule =
        AppRule(id = UUID.randomUUID().toString(), match = match.trim(), createdAt = System.currentTimeMillis())
}
