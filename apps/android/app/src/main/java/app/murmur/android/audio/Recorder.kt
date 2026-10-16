package app.murmur.android.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlin.math.log10
import kotlin.math.sqrt

const val SAMPLE_RATE = 16_000

/**
 * Microphone capture: 16 kHz mono PCM16, the same format the desktop overlay's AudioWorklet
 * produces. Levels are reported per ~50 ms chunk for the waveform in the overlay pill.
 */
class Recorder {
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private val chunks = ArrayList<ShortArray>()
    /** Samples in [chunks], kept alongside so a 30-minute session (36,000 chunks) is not summed on every poll. */
    private var buffered = 0
    @Volatile private var running = false

    /** Perceptual 0..1 level for the waveform, updated from the capture thread. */
    @Volatile var level: Float = 0f
        private set

    val isRecording: Boolean get() = running

    /** The samples captured so far from [from] on (a copy), for streaming a long dictation. */
    fun read(from: Int): ShortArray = synchronized(chunks) {
        val out = ShortArray(maxOf(0, buffered - from))
        // Walk back from the end to the chunk holding `from`: streaming reads only the last stretch
        // (under a minute), so this stays cheap however long the session runs.
        var i = chunks.size
        var pos = buffered
        while (i > 0 && pos > from) { i--; pos -= chunks[i].size }
        var at = 0
        for (k in i until chunks.size) {
            val c = chunks[k]
            val start = maxOf(0, from - pos)
            if (start < c.size) {
                System.arraycopy(c, start, out, at, c.size - start)
                at += c.size - start
            }
            pos += c.size
        }
        out
    }

    /** Samples captured so far in this session. */
    fun sampleCount(): Int = synchronized(chunks) { buffered }

    /** How many samples are buffered so far; for tests that watch a capture run. */
    @androidx.annotation.VisibleForTesting
    fun peekSampleCount(): Long = synchronized(chunks) { chunks.sumOf { it.size.toLong() } }

    /**
     * @param maxDurationSec stop on its own after this long, or null to run until [stop] (the
     *   default: `limitDuration` is off unless the user turns it on, as on the desktop).
     * @throws IllegalStateException when the microphone cannot be opened or started (in use by a
     *   call or another app, or the audio server refused the stream).
     */
    @SuppressLint("MissingPermission")
    fun start(maxDurationSec: Int?, onAutoStop: () -> Unit) {
        if (running) return
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(minBuf, SAMPLE_RATE) // >= 0.5 s of headroom
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            throw IllegalStateException("Microphone unavailable")
        }
        try {
            rec.startRecording()
            // Some devices (One UI in particular) do not throw when the mic is held by a call or
            // another app: startRecording() simply leaves the state at STOPPED.
            check(rec.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Microphone is busy" }
        } catch (e: Exception) {
            runCatching { rec.stop() }
            rec.release()
            throw IllegalStateException("Microphone is busy or unavailable", e)
        }

        synchronized(chunks) { chunks.clear(); buffered = 0 }
        record = rec
        running = true
        val maxSamples = maxDurationSec?.let { it.toLong() * SAMPLE_RATE }
        thread = Thread {
            val buf = ShortArray(SAMPLE_RATE / 20) // 50 ms
            var total = 0L
            var autoStop = false
            while (running) {
                val n = rec.read(buf, 0, buf.size)
                if (n < 0) break // ERROR_INVALID_OPERATION / ERROR_DEAD_OBJECT: the stream is gone
                if (n == 0) continue
                val copy = buf.copyOf(n)
                synchronized(chunks) { chunks.add(copy); buffered += copy.size }
                total += n
                level = perceptualLevel(copy)
                if (maxSamples != null && total >= maxSamples) {
                    autoStop = true
                    break
                }
            }
            // Release: what AudioRecord has buffered but not handed over yet is the end of the
            // last word; read it out before the stream is stopped (stop() discards it).
            // Cap at one buffer. A non-blocking read that never comes back short (Robolectric's
            // shadow answers every read at once) is newly invented audio, not the leftover tail.
            if (!autoStop) {
                val cap = rec.bufferSizeInFrames.coerceAtLeast(buf.size)
                var drained = 0
                while (drained < cap) {
                    val n = rec.read(buf, 0, minOf(buf.size, cap - drained), AudioRecord.READ_NON_BLOCKING)
                    if (n <= 0) break
                    val copy = buf.copyOf(n)
                    synchronized(chunks) { chunks.add(copy); buffered += copy.size }
                    drained += n
                }
            }
            if (autoStop && running) onAutoStop()
        }.apply {
            name = "murmur-recorder"
            start()
        }
    }

    fun stop(): ShortArray {
        // Post-roll: the button comes up while the last word is still sounding.
        if (running) Thread.sleep(STOP_POST_ROLL_MS)
        stopInternal()
        val list = synchronized(chunks) { ArrayList(chunks).also { chunks.clear(); buffered = 0 } }
        val total = list.sumOf { it.size }
        val out = ShortArray(total)
        var off = 0
        for (c in list) {
            c.copyInto(out, off)
            off += c.size
        }
        return out
    }

    fun cancel() {
        stopInternal()
        synchronized(chunks) { chunks.clear(); buffered = 0 }
    }

    private fun stopInternal() {
        running = false
        level = 0f
        val t = thread
        // The auto-stop callback runs on the capture thread itself; a thread cannot join itself.
        if (t != null && t !== Thread.currentThread()) t.join(500)
        thread = null
        record?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        record = null
    }

    /** Same perceptual dB mapping as the desktop overlay meter (-50 dB floor). */
    private fun perceptualLevel(buf: ShortArray): Float {
        var acc = 0.0
        for (s in buf) {
            val v = s / 32768.0
            acc += v * v
        }
        val rms = sqrt(acc / buf.size)
        if (rms <= 0.0) return 0f
        val db = 20 * log10(rms)
        return (((db + 50.0) / 50.0).coerceIn(0.0, 1.0)).toFloat()
    }
}

/** Audio kept after release so the end of the last word is not cut off. */
private const val STOP_POST_ROLL_MS = 200L
