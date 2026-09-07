package app.murmur.android

import app.murmur.android.history.HistoryEntry
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.LlmOutcome
import app.murmur.android.history.StageTimings
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class HistoryStoreTest {

    @get:Rule
    val folder = TemporaryFolder()

    private fun file() = File(folder.root, "history.json")

    private fun entry(id: String, at: Long = id.hashCode().toLong(), text: String = "hello $id") = HistoryEntry(
        id = id,
        createdAt = at,
        rawText = "um hello $id",
        finalText = text,
        wordCount = 2,
        speechMs = 1800,
        appName = "Messages",
        provider = "openai-compatible",
        model = "whisper-1",
        injected = true,
        llmUsed = true,
        llm = LlmOutcome.USED,
        stages = listOf("fillers", "capitalize"),
        timings = StageTimings(recordMs = 1800, sttMs = 640, formatMs = 3, llmMs = 410, injectMs = 25, totalMs = 1090)
    )

    @Test
    fun `entries are kept newest first and survive a restart byte for byte`() {
        val store = HistoryStore(file())
        store.add(entry("a"))
        store.add(entry("b"))
        assertEquals(listOf("b", "a"), store.entries.value.map { it.id })

        val reopened = HistoryStore(file())
        assertEquals(store.entries.value, reopened.entries.value)
        assertEquals(LlmOutcome.USED, reopened.get("a")?.llm)
        assertEquals(410L, reopened.get("a")?.timings?.llmMs)
    }

    @Test
    fun `adding an entry again replaces it instead of duplicating`() {
        val store = HistoryStore(file())
        store.add(entry("a", text = "first"))
        store.add(entry("a", text = "second"))
        assertEquals(1, store.size)
        assertEquals("second", store.get("a")?.finalText)
    }

    @Test
    fun `the oldest entries fall off past the cap`() {
        val store = HistoryStore(file(), maxEntries = 3)
        for (i in 1..5) store.add(entry("e$i"))
        assertEquals(listOf("e5", "e4", "e3"), store.entries.value.map { it.id })
        assertEquals(3, HistoryStore(file(), maxEntries = 3).size)
    }

    @Test
    fun `delete and clear are persisted`() {
        val store = HistoryStore(file())
        store.add(entry("a"))
        store.add(entry("b"))
        store.delete("a")
        assertNull(store.get("a"))
        assertEquals(listOf("b"), HistoryStore(file()).entries.value.map { it.id })
        store.clear()
        assertTrue(store.entries.value.isEmpty())
        assertTrue(HistoryStore(file()).entries.value.isEmpty())
    }

    @Test
    fun `a corrupt file is treated as empty rather than crashing`() {
        file().writeText("{not json")
        val store = HistoryStore(file())
        assertTrue(store.entries.value.isEmpty())
        store.add(entry("a"))
        assertEquals(1, HistoryStore(file()).size)
    }

    @Test
    fun `a failed dictation is an entry with an error and no text`() {
        val store = HistoryStore(file())
        store.add(entry("x").copy(finalText = "", wordCount = 0, injected = false, error = "Nothing heard"))
        val e = HistoryStore(file()).get("x")!!
        assertTrue(e.failed)
        assertEquals("Nothing heard", e.error)
    }
}
