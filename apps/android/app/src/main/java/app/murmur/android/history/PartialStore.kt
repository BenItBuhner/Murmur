package app.murmur.android.history

import android.util.Log
import app.murmur.android.dictation.DictationMode
import app.murmur.android.text.countWords
import app.murmur.android.text.joinPieces
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/** What a dictation in progress had transcribed so far (desktop: PartialTranscript). */
data class PartialTranscript(
    val id: String,
    val createdAt: Long,
    val mode: String,
    /** Streamed pieces' texts by index (null: a piece not back yet). */
    val texts: List<String?>
)

/**
 * Crash recovery for long dictations (desktop: PartialStore): each streamed piece's text is written
 * to `partials/<id>.json` as it comes back, and the file is removed when the dictation finishes
 * either way. A file still there at the next start is a dictation the app never finished (killed
 * in the background, a crash, the phone shutting down); its text goes to History instead of
 * being lost with 30 minutes of speech.
 */
class PartialStore(private val dir: File) {
    private fun fileFor(id: String) = File(dir, id.replace(Regex("[^A-Za-z0-9_-]"), "") + ".json")

    @Synchronized
    fun save(p: PartialTranscript) {
        try {
            dir.mkdirs()
            val json = JSONObject()
                .put("id", p.id)
                .put("createdAt", p.createdAt)
                .put("mode", p.mode)
                .put("texts", JSONArray().apply { p.texts.forEach { put(it ?: JSONObject.NULL) } })
            // Written aside and renamed, so a crash mid-write never leaves half a file.
            val file = fileFor(p.id)
            val tmp = File(dir, file.name + ".tmp")
            tmp.writeText(json.toString())
            if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
        } catch (e: Exception) {
            Log.w("Murmur", "could not save a partial transcript", e)
        }
    }

    @Synchronized
    fun clear(id: String) {
        runCatching { fileFor(id).delete() }
    }

    /** The partials left by dictations that never finished; each is removed as it is read. */
    @Synchronized
    fun takeAll(): List<PartialTranscript> {
        val files = dir.listFiles() ?: return emptyList()
        val out = ArrayList<PartialTranscript>()
        for (f in files) {
            try {
                if (f.name.endsWith(".json")) {
                    val o = JSONObject(f.readText())
                    val arr = o.getJSONArray("texts")
                    out.add(
                        PartialTranscript(
                            o.getString("id"), o.getLong("createdAt"), o.optString("mode", DictationMode.HANDS_FREE.id),
                            (0 until arr.length()).map { if (arr.isNull(it)) null else arr.getString(it) }
                        )
                    )
                }
            } catch (e: Exception) {
                Log.w("Murmur", "unreadable partial ${f.name}", e)
            }
            f.delete()
        }
        return out.sortedBy { it.createdAt }
    }
}

/** What History says on an entry recovered from a dictation the app never finished (desktop: RECOVERED_NOTE). */
const val RECOVERED_NOTE =
    "Murmur closed before this dictation finished. This is the text transcribed until then; the end may be missing."

/** The History entry for a partial left behind, or null when nothing had come back yet. */
fun recoveredEntry(p: PartialTranscript): HistoryEntry? {
    val text = joinPieces(p.texts.filterNotNull().filter { it.isNotBlank() }).text.trim()
    if (text.isEmpty()) return null
    return HistoryEntry(
        id = p.id,
        createdAt = p.createdAt,
        mode = DictationMode.entries.firstOrNull { it.id == p.mode } ?: DictationMode.HANDS_FREE,
        rawText = text,
        finalText = text,
        wordCount = countWords(text),
        speechMs = 0,
        provider = "murmur",
        model = "",
        injected = false,
        llmUsed = false,
        stages = listOf("recovered"),
        error = RECOVERED_NOTE
    )
}
