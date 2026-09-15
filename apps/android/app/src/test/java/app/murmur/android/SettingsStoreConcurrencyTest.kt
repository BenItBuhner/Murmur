package app.murmur.android

import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsOrigin
import app.murmur.android.settings.SettingsStore
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Settings are updated from more than one thread at once: the UI and the sync engine change
 * preferences while the dictation pipeline records a finished dictation's stats from a worker
 * thread moments after the text landed. An update must never overwrite another one's change.
 *
 * Before [SettingsStore.update] was made atomic this lost updates every time (the last writer's
 * copy of the *previous* settings replaced everything a faster writer had changed); on CI the
 * pipeline's stats update from one DictationFlowTest method overwrote the next method's base URL,
 * which then dictated into a mock server that had already shut down.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SettingsStoreConcurrencyTest {

    @Test
    fun `concurrent updates keep every change`() {
        val store = SettingsStore(RuntimeEnvironment.getApplication())
        val workers = 4
        val rounds = 250
        val pool = Executors.newFixedThreadPool(workers)
        val go = CountDownLatch(1)
        val done = CountDownLatch(workers)
        val recorded = AtomicInteger()
        repeat(workers) {
            pool.execute {
                go.await()
                repeat(rounds) {
                    // What the pipeline does after every dictation: fold one session into the stats.
                    store.update { s -> s.copy(stats = s.stats.record(3, 1200, "2026-09-15")) }
                    recorded.incrementAndGet()
                }
                done.countDown()
            }
        }
        go.countDown()
        // Meanwhile the "main" thread keeps changing unrelated fields, the way a test's set-up (or
        // a user under Speech model) does while a dictation is still being counted.
        var lastUrl = ""
        var i = 0
        while (done.count > 0 && i < 100_000) {
            lastUrl = "http://127.0.0.1:${40_000 + (i % 1000)}/v1"
            val url = lastUrl
            store.update { s -> s.copy(sttBaseUrl = url, sttModel = "mock-$i") }
            i++
        }
        done.await(60, TimeUnit.SECONDS)
        pool.shutdown()

        val s = store.get()
        assertEquals("every stats update counted", workers * rounds, s.stats.totalSessions)
        assertEquals(workers * rounds * 3, s.stats.totalWords)
        assertEquals("the last base URL written survives the stats updates", lastUrl, s.sttBaseUrl)
        assertEquals("mock-${i - 1}", s.sttModel)
    }

    @Test
    fun `listeners see the changes in the order they were published`() {
        val store = SettingsStore(RuntimeEnvironment.getApplication())
        val seen = ArrayList<Pair<Int, Int>>()
        store.addListener { previous: MurmurSettings, next: MurmurSettings, _: SettingsOrigin ->
            synchronized(seen) { seen.add(previous.stats.totalSessions to next.stats.totalSessions) }
        }
        val pool = Executors.newFixedThreadPool(4)
        val done = CountDownLatch(4)
        repeat(4) {
            pool.execute {
                repeat(50) { store.update { s -> s.copy(stats = s.stats.record(1, 100, "2026-09-15")) } }
                done.countDown()
            }
        }
        done.await(60, TimeUnit.SECONDS)
        pool.shutdown()
        // Each change continues from the one before it: no gaps, no repeats, no reordering.
        assertEquals(200, seen.size)
        seen.forEachIndexed { index, (previous, next) ->
            assertEquals("change $index starts where the previous one ended", index, previous)
            assertEquals(index + 1, next)
        }
    }
}
