package app.murmur.android.history

import android.content.Context
import android.util.Log
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private const val TAG = "MurmurHistory"

/** How long each step of a dictation took; the same breakdown the desktop app shows. */
@Serializable
data class StageTimings(
    /** Speech captured: from the tap that started listening to the tap that stopped it. */
    val recordMs: Long = 0,
    val sttMs: Long = 0,
    val formatMs: Long = 0,
    val llmMs: Long = 0,
    val injectMs: Long = 0,
    /** Stop tap -> text in the field. */
    val totalMs: Long = 0
)

/**
 * What the smart-formatting stage did, so History can explain the result.
 *   USED      the model's text was inserted
 *   REJECTED  the model's answer failed the guard rails; the rule-based text was inserted
 *   FAILED    the request errored or timed out; the rule-based text was inserted
 *   SKIPPED   the model was not asked (mode, too short, no model configured)
 */
@Serializable
enum class LlmOutcome {
    @SerialName("used") USED,
    @SerialName("rejected") REJECTED,
    @SerialName("failed") FAILED,
    @SerialName("skipped") SKIPPED
}

/** One dictation, kept on the phone. Mirrors the desktop `HistoryEntry` minus desktop-only fields. */
@Serializable
data class HistoryEntry(
    val id: String,
    val createdAt: Long,
    /** What the speech model heard. */
    val rawText: String,
    /** What was inserted; empty when the dictation failed. */
    val finalText: String,
    val wordCount: Int,
    val speechMs: Long,
    /** Label of the app that owned the text field ("Messages"), when known. */
    val appName: String? = null,
    val provider: String,
    val model: String,
    val injected: Boolean,
    val llmUsed: Boolean,
    val llm: LlmOutcome? = null,
    /** Guard reason, error message, or why the model was skipped. */
    val llmDetail: String? = null,
    /** Rule-based stages that changed the text, in order. */
    val stages: List<String> = emptyList(),
    val timings: StageTimings = StageTimings(),
    val error: String? = null
) {
    val failed: Boolean get() = error != null
}

/**
 * Dictation history for this phone: newest first, capped at [maxEntries], persisted as one JSON
 * file. Reads are served from memory through [entries]; writes go to disk through [scope], or
 * inline when there is none (tests).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HistoryStore(
    private val file: File,
    private val maxEntries: Int = MAX_ENTRIES,
    private val scope: CoroutineScope? = null
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val _entries = MutableStateFlow(load())

    /** Every dictation kept, newest first. */
    val entries: StateFlow<List<HistoryEntry>> = _entries

    val size: Int get() = _entries.value.size

    fun get(id: String): HistoryEntry? = _entries.value.firstOrNull { it.id == id }

    @Synchronized
    fun add(entry: HistoryEntry) {
        commit(listOf(entry) + _entries.value.filter { it.id != entry.id })
    }

    @Synchronized
    fun delete(id: String) {
        val current = _entries.value
        val next = current.filter { it.id != id }
        if (next.size != current.size) commit(next)
    }

    @Synchronized
    fun clear() {
        if (_entries.value.isNotEmpty()) commit(emptyList())
    }

    private fun commit(list: List<HistoryEntry>) {
        val next = list.take(maxEntries)
        _entries.value = next
        if (scope == null) persist(next) else scope.launch { persist(next) }
    }

    private fun load(): List<HistoryEntry> {
        if (!file.exists()) return emptyList()
        return try {
            json.decodeFromString<List<HistoryEntry>>(file.readText()).take(maxEntries)
        } catch (e: Exception) {
            Log.w(TAG, "history file unreadable; starting over", e)
            emptyList()
        }
    }

    /** Write to a sibling and swap it in, so a crash mid-write never loses the whole history. */
    private fun persist(list: List<HistoryEntry>) {
        try {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(json.encodeToString(list))
            if (!tmp.renameTo(file)) {
                file.writeText(json.encodeToString(list))
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.e(TAG, "could not save history", e)
        }
    }

    companion object {
        /** A phone keeps fewer than the desktop's 2000; the file is read whole on start. */
        const val MAX_ENTRIES = 500

        @Volatile
        private var instance: HistoryStore? = null

        fun get(context: Context): HistoryStore =
            instance ?: synchronized(this) {
                instance ?: HistoryStore(
                    File(context.applicationContext.filesDir, "history.json"),
                    scope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(1))
                ).also { instance = it }
            }
    }
}
