package app.murmur.android

import app.murmur.android.history.RecordingStore
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RecordingStoreTest {

    @get:Rule
    val folder = TemporaryFolder()

    private fun store(budget: Long = RecordingStore.DEFAULT_BUDGET_BYTES) = RecordingStore(File(folder.root, "recordings"), budget)

    private fun tone(seconds: Double): ShortArray =
        ShortArray((seconds * 16_000).toInt()) { (kotlin.math.sin(it / 20.0) * 12000).toInt().toShort() }

    @Test
    fun `a dictation is stored as WAV and reads back sample for sample`() {
        val store = store()
        val pcm = tone(1.5)
        val name = store.save("7f2c1b7e-0000-4000-8000-000000000001", pcm, 16_000)
        assertEquals("7f2c1b7e-0000-4000-8000-000000000001.wav", name)
        assertTrue(store.has(name))
        val (back, rate) = store.read(name)!!
        assertEquals(16_000, rate)
        assertArrayEquals(pcm, back)
        assertEquals(1, store.info().count)
        assertEquals(44L + pcm.size * 2, store.info().bytes)
    }

    @Test
    fun `has and read refuse what is missing or is not a recording name`() {
        val store = store()
        assertFalse(store.has(null))
        assertFalse(store.has("missing.wav"))
        assertFalse(store.has("../history.json"))
        assertNull(store.read("missing.wav"))
    }

    @Test
    fun `delete, clear and sweep`() {
        val store = store()
        val a = store.save("a", tone(0.2), 16_000)
        val b = store.save("b", tone(0.2), 16_000)
        val c = store.save("c", tone(0.2), 16_000)
        File(store.dir, "notes.txt").writeText("not audio")

        store.delete(a)
        assertFalse(store.has(a))
        assertEquals(2, store.info().count)

        // Just written: a dictation still in flight, not an orphan.
        store.sweep(setOf(b))
        assertTrue(store.has(c))
        store.sweep(setOf(b), now = System.currentTimeMillis() + RecordingStore.IN_FLIGHT_MS + 1)
        assertTrue(store.has(b))
        assertFalse(store.has(c))

        store.clear()
        assertEquals(0, store.info().count)
        assertTrue(File(store.dir, "notes.txt").exists())
    }

    @Test
    fun `the oldest recordings go first once the budget is exceeded`() {
        val fileBytes = 44L + tone(1.0).size * 2
        val store = store(budget = fileBytes * 2 + 10)
        val old = store.save("old", tone(1.0), 16_000)
        File(store.dir, old).setLastModified(System.currentTimeMillis() - 60_000)
        val mid = store.save("mid", tone(1.0), 16_000)
        val fresh = store.save("fresh", tone(1.0), 16_000)

        assertFalse(store.has(old))
        assertTrue(store.has(mid))
        assertTrue(store.has(fresh))
    }
}
