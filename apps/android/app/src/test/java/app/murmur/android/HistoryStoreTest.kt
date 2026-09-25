package app.murmur.android

import app.murmur.android.history.HistoryEntry
import app.murmur.android.history.HistoryEvent
import app.murmur.android.history.HistoryOrigin
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.LlmOutcome
import app.murmur.android.history.RecordingStore
import app.murmur.android.history.StageTimings
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    @Test
    fun `replace keeps the entry in place and only its outcome changes`() {
        val store = HistoryStore(file())
        store.add(entry("a").copy(finalText = "", wordCount = 0, injected = false, error = "Timed out", recording = "a.wav"))
        store.add(entry("b"))
        store.add(entry("c"))
        assertTrue(store.get("a")!!.retryable)

        store.replace(entry("a", text = "now it worked").copy(recording = "a.wav", attempts = 2))

        assertEquals(listOf("c", "b", "a"), store.entries.value.map { it.id })
        val a = HistoryStore(file()).get("a")!!
        assertEquals("now it worked", a.finalText)
        assertEquals(2, a.attempts)
        assertFalse(a.retryable)

        store.replace(entry("z"))
        assertEquals("z", store.entries.value.first().id)
    }

    @Test
    fun `a recording never outlives its entry`() {
        val recordings = RecordingStore(File(folder.root, "recordings"))
        val store = HistoryStore(file(), maxEntries = 3, recordings = recordings)
        val pcm = ShortArray(1600) { (it % 100).toShort() }
        val names = (1..4).map { i -> recordings.save("e$i", pcm, 16_000) }
        for (i in 1..3) store.add(entry("e$i").copy(recording = names[i - 1]))

        // Evicted past the cap.
        store.add(entry("e4").copy(recording = names[3]))
        assertFalse(recordings.has(names[0]))
        assertTrue(recordings.has(names[1]))

        // Replaced without its audio (the user does not keep successful recordings).
        store.replace(store.get("e2")!!.copy(recording = null))
        assertFalse(recordings.has(names[1]))

        store.delete("e3")
        assertFalse(recordings.has(names[2]))

        store.stripRecordings()
        assertNull(store.get("e4")!!.recording)
        assertFalse(recordings.has(names[3]))
        assertEquals(0, recordings.info().count)

        store.add(entry("e5").copy(recording = recordings.save("e5", pcm, 16_000)))
        store.clear()
        assertEquals(0, recordings.info().count)
    }

    private fun remote(id: String, at: Long, device: String? = "Ben's desk") =
        entry(id, at, text = "from the desk $id").copy(recording = null, timings = StageTimings(recordMs = 1800), deviceId = "desk", deviceName = device, remote = true)

    @Test
    fun `merging remote entries never touches this phone's and drops the ones gone upstream`() {
        val store = HistoryStore(file())
        store.add(entry("a", at = 10, text = "mine").copy(recording = "a.wav"))
        store.mergeRemote(listOf(remote("r1", 30), remote("r2", 20), remote("a", 10).copy(finalText = "the account's copy of mine")))
        assertEquals(listOf("r1", "r2", "a"), store.entries.value.map { it.id })
        // The phone's own copy stands, recording and timings included; the server's echo of it is ignored.
        val own = store.get("a")!!
        assertEquals("mine", own.finalText)
        assertEquals("a.wav", own.recording)
        assertFalse(own.remote)
        assertTrue(store.get("r1")!!.remote)
        assertEquals("Ben's desk", store.get("r1")!!.deviceName)

        // The same snapshot again changes nothing; one without r2 drops it; a newer one slots in by date.
        store.mergeRemote(listOf(remote("r1", 30), remote("r2", 20)))
        assertEquals(listOf("r1", "r2", "a"), store.entries.value.map { it.id })
        store.mergeRemote(listOf(remote("r1", 30), remote("r3", 15)))
        assertEquals(listOf("r1", "r3", "a"), store.entries.value.map { it.id })
        // A remote entry already here keeps its first copy even if the server's changed.
        store.mergeRemote(listOf(remote("r1", 30, device = null), remote("r3", 15)))
        assertEquals("Ben's desk", store.get("r1")!!.deviceName)

        // Remote entries are persisted with their device, and removeRemote leaves only the phone's own.
        val reopened = HistoryStore(file())
        assertEquals(listOf("r1", "r3", "a"), reopened.entries.value.map { it.id })
        assertTrue(reopened.get("r3")!!.remote)
        assertEquals("desk", reopened.get("r3")!!.deviceId)
        store.removeRemote()
        assertEquals(listOf("a"), store.entries.value.map { it.id })
        assertEquals(listOf("a"), HistoryStore(file()).entries.value.map { it.id })
    }

    @Test
    fun `the cap applies across local and remote entries alike`() {
        val store = HistoryStore(file(), maxEntries = 3)
        store.add(entry("a", at = 10))
        store.add(entry("b", at = 40))
        store.mergeRemote(listOf(remote("r1", 30), remote("r2", 20), remote("r3", 50)))
        assertEquals(listOf("r3", "b", "r1"), store.entries.value.map { it.id })
    }

    @Test
    fun `listeners hear the user's changes with their origin, and nothing of a remote merge`() {
        val store = HistoryStore(file())
        val events = ArrayList<HistoryEvent>()
        store.addListener { events += it }
        store.add(entry("a", at = 10))
        store.replace(entry("a", at = 10, text = "again"))
        store.mergeRemote(listOf(remote("r1", 30)))
        store.removeRemote()
        store.delete("a")
        store.delete("r1", HistoryOrigin.CLOUD)
        store.clear()
        store.clear(HistoryOrigin.CLOUD)
        assertEquals(
            listOf(
                HistoryEvent.Added(entry("a", at = 10)),
                HistoryEvent.Replaced(entry("a", at = 10, text = "again")),
                HistoryEvent.Deleted("a", HistoryOrigin.LOCAL),
                HistoryEvent.Deleted("r1", HistoryOrigin.CLOUD),
                HistoryEvent.Cleared(HistoryOrigin.LOCAL),
                HistoryEvent.Cleared(HistoryOrigin.CLOUD)
            ),
            events
        )
    }

    @Test
    fun `history files written before recordings existed still load`() {
        file().writeText(
            """[{"id":"old","createdAt":1,"rawText":"","finalText":"hi","wordCount":1,"speechMs":1,
               "provider":"p","model":"m","injected":true,"llmUsed":false}]"""
        )
        val e = HistoryStore(file()).get("old")!!
        assertNull(e.recording)
        assertEquals(1, e.attempts)
        assertFalse(e.retryable)
    }
}
