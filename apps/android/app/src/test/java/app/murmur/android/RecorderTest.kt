package app.murmur.android

import app.murmur.android.audio.Recorder
import app.murmur.android.audio.SAMPLE_RATE
import app.murmur.android.settings.MurmurSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The session length limit, as the recorder applies it. Robolectric's AudioRecord answers every
 * read at once, so "minutes" of audio arrive in milliseconds: a capped recorder stops itself as
 * soon as the cap's worth of samples is in, and an uncapped one (the default, as on the desktop)
 * runs until it is told to stop.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RecorderTest {

    @Test
    fun `without a limit the recorder runs until it is stopped`() {
        assertNull("the limit is off by default", MurmurSettings().sessionDurationLimitSec)
        val recorder = Recorder()
        var autoStopped = false
        recorder.start(null) { autoStopped = true }
        // Long enough for the shadow to have delivered far more than any cap a person would set.
        val deadline = System.currentTimeMillis() + 5_000
        var samples = 0L
        while (System.currentTimeMillis() < deadline && samples < SAMPLE_RATE * 30L) {
            Thread.sleep(20)
            samples = recorder.peekSampleCount()
        }
        assertTrue("still recording after ${samples / SAMPLE_RATE} s of audio", recorder.isRecording)
        assertFalse(autoStopped)
        val pcm = recorder.stop()
        assertTrue("captured ${pcm.size} samples", pcm.size >= SAMPLE_RATE * 30L)
        assertFalse(recorder.isRecording)
    }

    @Test
    fun `with the limit on the recorder stops itself at the maximum length`() {
        assertEquals(120, MurmurSettings(limitDuration = true, maxDurationSec = 120).sessionDurationLimitSec)
        val recorder = Recorder()
        val stopped = CountDownLatch(1)
        recorder.start(2) { stopped.countDown() }
        assertTrue("auto-stop fired", stopped.await(10, TimeUnit.SECONDS))
        val pcm = recorder.stop()
        // Two seconds of samples, give or take the chunk the cap landed in.
        assertTrue("captured ${pcm.size} samples", pcm.size >= SAMPLE_RATE * 2L)
        assertTrue("captured ${pcm.size} samples", pcm.size <= SAMPLE_RATE * 2L + SAMPLE_RATE / 20)
    }
}
