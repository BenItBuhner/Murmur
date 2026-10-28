package app.murmur.android.settings

import android.content.Context
import android.content.SharedPreferences
import app.murmur.android.text.WordCorrection
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** A word Murmur noticed the user correcting and offers to add to the dictionary. */
@Serializable
data class WordSuggestion(
    val word: String,
    val heard: String,
    /** "add" for a new word, "alias" for a new way an existing word is mis-heard. */
    val kind: String,
    val at: Long
)

/**
 * The dictionary suggestions waiting for an answer, and the words the user turned down (never
 * offered again, as in Wispr Flow). Device-local: only an accepted word reaches the dictionary,
 * and through it the account.
 */
class WordSuggestions private constructor(private val prefs: SharedPreferences) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val _pending = MutableStateFlow(load())
    val pending: StateFlow<List<WordSuggestion>> = _pending

    private fun load(): List<WordSuggestion> = runCatching {
        json.decodeFromString<List<WordSuggestion>>(prefs.getString(KEY_PENDING, null) ?: "[]")
    }.getOrDefault(emptyList())

    private fun declined(): Set<String> = prefs.getStringSet(KEY_DECLINED, emptySet()) ?: emptySet()

    private fun save(list: List<WordSuggestion>) {
        _pending.value = list
        prefs.edit().putString(KEY_PENDING, json.encodeToString(list)).apply()
    }

    /**
     * Record what an edit taught us. Returns the suggestions that are new (not declined, not
     * already waiting, not in the dictionary by now), so the caller can tell the user once.
     */
    @Synchronized
    fun offer(corrections: List<WordCorrection>, dictionary: List<DictionaryEntry>, now: Long = System.currentTimeMillis()): List<WordSuggestion> {
        val declined = declined()
        val current = _pending.value
        val fresh = corrections.filter { c ->
            val key = c.word.lowercase()
            key !in declined &&
                current.none { it.word.equals(c.word, ignoreCase = true) && it.heard.equals(c.heard, ignoreCase = true) } &&
                dictionary.none { d ->
                    d.word.equals(c.word, ignoreCase = true) &&
                        (c.kind == "add" || d.aliases.any { it.equals(c.heard, ignoreCase = true) })
                }
        }.map { WordSuggestion(it.word, it.heard, it.kind, now) }
        if (fresh.isNotEmpty()) save((fresh + current).take(MAX_PENDING))
        return fresh
    }

    /** Put the word in the dictionary (or the mis-hearing on its entry) and forget the suggestion. */
    @Synchronized
    fun accept(word: String, store: SettingsStore) {
        val suggestion = _pending.value.firstOrNull { it.word.equals(word, ignoreCase = true) } ?: return
        store.update { s -> s.copy(dictionaryEntries = withSuggestion(s.dictionaryEntries, suggestion)) }
        save(_pending.value.filterNot { it.word.equals(word, ignoreCase = true) })
    }

    /** Never offer this word again. */
    @Synchronized
    fun decline(word: String) {
        prefs.edit().putStringSet(KEY_DECLINED, (declined() + word.lowercase()).toSet()).apply()
        save(_pending.value.filterNot { it.word.equals(word, ignoreCase = true) })
    }

    companion object {
        private const val PREFS = "murmur_word_suggestions"
        private const val KEY_PENDING = "pending"
        private const val KEY_DECLINED = "declined"
        private const val MAX_PENDING = 20

        @Volatile private var instance: WordSuggestions? = null

        fun get(context: Context): WordSuggestions = instance ?: synchronized(this) {
            instance ?: WordSuggestions(context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)).also { instance = it }
        }

        /** The dictionary with the suggestion applied: a new entry, or one more "heard as" on the existing one. */
        fun withSuggestion(entries: List<DictionaryEntry>, s: WordSuggestion): List<DictionaryEntry> {
            val existing = entries.firstOrNull { it.word.equals(s.word, ignoreCase = true) }
            val heard = s.heard.takeIf { !it.equals(s.word, ignoreCase = true) }
            if (existing == null) return listOf(DictionaryCodec.newEntry(s.word, listOfNotNull(heard))) + entries
            // Only the casing was corrected: the entry takes the user's casing.
            if (heard == null) return if (existing.word == s.word) entries else entries.map { if (it.id == existing.id) it.copy(word = s.word) else it }
            if (existing.aliases.any { it.equals(heard, ignoreCase = true) }) return entries
            return entries.map { if (it.id == existing.id) it.copy(aliases = it.aliases + heard) else it }
        }
    }
}
