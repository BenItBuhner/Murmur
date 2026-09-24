package app.murmur.android.settings

import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * One voice snippet: a spoken trigger and the text that replaces it after the model has run.
 * Identical in shape to the desktop app's (apps/desktop/src/shared/settings.ts) and to the wire
 * format of the backend so a snippet synced from the account drops straight in.
 */
@Serializable
data class Snippet(
    val id: String,
    val trigger: String,
    val content: String,
    val createdAt: Long = 0L
)

object SnippetCodec {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun encode(snippets: List<Snippet>): String = json.encodeToString(snippets)

    fun decode(raw: String?): List<Snippet> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            json.decodeFromString<List<Snippet>>(raw).filter { it.trigger.isNotBlank() }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun newSnippet(trigger: String, content: String): Snippet =
        Snippet(
            id = UUID.randomUUID().toString(),
            trigger = trigger.trim(),
            content = content,
            createdAt = System.currentTimeMillis()
        )
}
