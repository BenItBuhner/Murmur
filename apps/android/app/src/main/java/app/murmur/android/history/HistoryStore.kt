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
    val error: String? = null,
    /**
     * File name of the stored audio (16 kHz mono WAV) in the recordings directory, when it was kept.
     * A failed dictation always keeps its recording so it can be sent again; whether successful
     * ones do is the "Keep recordings" setting.
     */
    val recording: String? = null,
    /** How many times this audio has been sent for transcription. */
    val attempts: Int = 1
) {
    val failed: Boolean get() = error != null

    /** Nothing was inserted and the audio is still here: the dictation can be sent again. */
    val retryable: Boolean get() = finalText.isEmpty() && recording != null
}

/**
 * Dictation history for this phone: newest first, capped at [maxEntries], persisted as one JSON
 * file. Reads are served from memory through [entries]; writes go to disk through [scope], or
 * inline when there is none (tests).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HistoryStore(
    val file: File,
    private val maxEntries: Int = MAX_ENTRIES,
    private val scope: CoroutineScope? = null,
    /** Where the entries' audio lives, so a recording never outlives its entry. */
    private val recordings: RecordingStore? = null
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

    /**
     * A dictation sent again: the entry keeps its place in the list (and its date) and only its
     * outcome changes. Falls back to [add] when the entry is gone.
     */
    @Synchronized
    fun replace(entry: HistoryEntry) {
        val current = _entries.value
        val index = current.indexOfFirst { it.id == entry.id }
        if (index < 0) {
            add(entry)
            return
        }
        commit(current.toMutableList().also { it[index] = entry })
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

    /** The user deleted every recording: the entries stay, their audio references go. */
    @Synchronized
    fun stripRecordings() {
        val current = _entries.value
        if (current.none { it.recording != null }) return
        commit(current.map { if (it.recording == null) it else it.copy(recording = null) })
    }

    /** Every recording file the current entries refer to. */
    fun recordingNames(): Set<String> = _entries.value.mapNotNull { it.recording }.toSet()

    /** Persist the list, deleting the recordings of entries that are no longer in it. */
    private fun commit(list: List<HistoryEntry>) {
        val previous = _entries.value
        val next = list.take(maxEntries)
        _entries.value = next
        if (recordings != null) {
            val kept = next.mapNotNull { it.recording }.toSet()
            for (e in previous + list.drop(maxEntries)) {
                val name = e.recording ?: continue
                if (name !in kept) recordings.delete(name)
            }
        }
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

        /** One store per app data directory (which only ever changes under test). */
        fun get(context: Context): HistoryStore {
            val file = File(context.applicationContext.filesDir, "history.json")
            instance?.takeIf { it.file == file }?.let { return it }
            return synchronized(this) {
                instance?.takeIf { it.file == file } ?: HistoryStore(
                    file,
                    scope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(1)),
                    recordings = RecordingStore.get(context)
                ).also { store ->
                    instance = store
                    RecordingStore.get(context).sweep(store.recordingNames())
                }
            }
        }
    }
}
