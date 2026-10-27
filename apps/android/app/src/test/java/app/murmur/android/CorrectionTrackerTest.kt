package app.murmur.android

import android.os.Handler
import android.os.Looper
import app.murmur.android.learn.CorrectionTracker
import app.murmur.android.text.WordCorrection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLooper
import java.time.Duration

/** The tracker's timing: when it reads the field after a dictation, and what it reports. */
@RunWith(RobolectricTestRunner::class)
class CorrectionTrackerTest {
    private var field = ""
    private val found = mutableListOf<WordCorrection>()
    private val tracker = CorrectionTracker(
        Handler(Looper.getMainLooper()),
        dictionary = { emptyList() },
        onFound = { found += it }
    )

    private fun pass(ms: Long) = ShadowLooper.idleMainLooper(ms, java.util.concurrent.TimeUnit.MILLISECONDS)

    @Test
    fun `a web page that reports the pasted text late is still watched`() {
        // Chrome shows the paste to accessibility only after a moment; the first reads see an empty box.
        tracker.start("I use whisper flow every day. ") { field to field.length }
        pass(700)
        field = "I use whisper flow every day. "
        pass(1_000)
        field = "I use Wispr Flow every day. "
        tracker.nudge()
        pass(5_000)
        assertEquals(listOf("Wispr Flow"), found.map { it.word })
    }

    @Test
    fun `a field that never shows the dictation is given up on`() {
        tracker.start("I use whisper flow every day. ") { "something else" to 3 }
        pass(Duration.ofMinutes(2).toMillis())
        field = "I use Wispr Flow every day. "
        tracker.nudge()
        pass(5_000)
        assertTrue(found.isEmpty())
    }
}
