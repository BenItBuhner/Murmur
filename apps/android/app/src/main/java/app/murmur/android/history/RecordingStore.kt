package app.murmur.android.history

import android.content.Context
import android.util.Log
import app.murmur.android.audio.Wav
import java.io.File

private const val TAG = "MurmurRecordings"

/** What the recordings directory holds, for the settings UI. */
data class RecordingsInfo(val count: Int, val bytes: Long)

/**
 * The audio behind History entries: one WAV per dictation in `recordings/`, named after the entry.
 * Files are what make "send it again" possible after a failed request, and what History plays
 * back. The directory is kept under a byte budget (oldest files go first) and swept of files whose
 * entry is gone. Mirrors the desktop `RecordingStore`.
 */
class RecordingStore(
    val dir: File,
    private val budgetBytes: Long = DEFAULT_BUDGET_BYTES
) {
    fun file(name: String): File {
        require(FILE_NAME.matches(name)) { "Not a recording file name: $name" }
        return File(dir, name)
    }

    fun has(name: String?): Boolean = name != null && FILE_NAME.matches(name) && File(dir, name).isFile

    /** Write the dictation's audio as WAV and return the file name to store on the entry. */
    fun save(id: String, pcm: ShortArray, sampleRate: Int): String {
        val name = fileFor(id)
        dir.mkdirs()
        val target = File(dir, name)
        val tmp = File(dir, "$name.tmp")
        tmp.writeBytes(Wav.encodePcm16(pcm, sampleRate))
        if (!tmp.renameTo(target)) {
            target.writeBytes(tmp.readBytes())
            tmp.delete()
        }
        prune()
        return name
    }

    /** The stored samples and their sample rate, or null when the file is gone or unreadable. */
    fun read(name: String): Pair<ShortArray, Int>? {
        if (!has(name)) return null
        return try {
            Wav.decodePcm16(File(dir, name).readBytes())
        } catch (e: Exception) {
            Log.w(TAG, "recording $name unreadable", e)
            null
        }
    }

    fun delete(name: String?) {
        if (name == null || !FILE_NAME.matches(name)) return
        File(dir, name).delete()
    }

    fun clear() {
        for (f in files()) f.delete()
    }

    fun info(): RecordingsInfo {
        val files = files()
        return RecordingsInfo(files.size, files.sumOf { it.length() })
    }

    /** Drop the oldest files until the directory fits the budget. */
    fun prune() {
        val files = files().sortedBy { it.lastModified() }
        var total = files.sumOf { it.length() }
        for (f in files) {
            if (total <= budgetBytes) break
            total -= f.length()
            f.delete()
        }
    }

    /**
     * Delete every file that no history entry refers to (entries evicted, files left behind). A file
     * written moments ago belongs to a dictation still in flight, whose entry is not there yet.
     */
    fun sweep(keep: Set<String>, now: Long = System.currentTimeMillis()) {
        var removed = 0
        for (f in files()) {
            if (f.name in keep || now - f.lastModified() < IN_FLIGHT_MS) continue
            if (f.delete()) removed++
        }
        if (removed > 0) Log.i(TAG, "removed $removed orphaned recording(s)")
    }

    private fun files(): List<File> =
        dir.listFiles { f -> f.isFile && FILE_NAME.matches(f.name) }?.toList() ?: emptyList()

    companion object {
        /** 16 kHz mono PCM is ~1.9 MB per minute; 200 MB is well over an hour and a half of speech. */
        const val DEFAULT_BUDGET_BYTES = 200L * 1024 * 1024

        /** Younger than this, a file without an entry is a dictation being processed, not an orphan. */
        const val IN_FLIGHT_MS = 60_000L

        private val FILE_NAME = Regex("^[A-Za-z0-9_-]+\\.wav$")

        /** File name for a history entry id; ids are UUIDs, so the name is always a safe path segment. */
        fun fileFor(id: String): String = id.replace(Regex("[^A-Za-z0-9_-]"), "") + ".wav"

        @Volatile
        private var instance: RecordingStore? = null

        /** One store per app data directory (which only ever changes under test). */
        fun get(context: Context): RecordingStore {
            val dir = File(context.applicationContext.filesDir, "recordings")
            instance?.takeIf { it.dir == dir }?.let { return it }
            return synchronized(this) {
                instance?.takeIf { it.dir == dir } ?: RecordingStore(dir).also { instance = it }
            }
        }
    }
}
