package app.murmur.android.settings

import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * One dictionary entry, identical in shape to the desktop app's
 * (apps/desktop/src/shared/settings.ts) and to the wire format of the backend so an entry synced
 * from the account drops straight in.
 */
@Serializable
data class DictionaryEntry(
    val id: String,
    val word: String,
    val aliases: List<String> = emptyList(),
    val fuzzy: Boolean = false,
    val createdAt: Long = 0L
)

object DictionaryCodec {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun encode(entries: List<DictionaryEntry>): String = json.encodeToString(entries)

    fun decode(raw: String?): List<DictionaryEntry> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            json.decodeFromString<List<DictionaryEntry>>(raw).filter { it.word.isNotBlank() }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** Older builds stored the dictionary as one comma-separated string. */
    fun fromLegacy(commaSeparated: String, now: Long = System.currentTimeMillis()): List<DictionaryEntry> =
        commaSeparated.split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinctBy { it.lowercase() }
            .map { DictionaryEntry(id = UUID.randomUUID().toString(), word = it, createdAt = now) }

    fun newEntry(word: String, aliases: List<String> = emptyList(), fuzzy: Boolean = false): DictionaryEntry =
        DictionaryEntry(
            id = UUID.randomUUID().toString(),
            word = word.trim(),
            aliases = aliases.map { it.trim() }.filter { it.isNotEmpty() && !it.equals(word.trim(), ignoreCase = true) },
            fuzzy = fuzzy,
            createdAt = System.currentTimeMillis()
        )
}
