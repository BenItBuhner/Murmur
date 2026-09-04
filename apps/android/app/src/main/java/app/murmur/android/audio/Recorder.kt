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
    @Volatile private var running = false

    /** Perceptual 0..1 level for the waveform, updated from the capture thread. */
    @Volatile var level: Float = 0f
        private set

    val isRecording: Boolean get() = running

    @SuppressLint("MissingPermission")
    fun start(maxDurationSec: Int, onAutoStop: () -> Unit) {
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
        check(rec.state == AudioRecord.STATE_INITIALIZED) { "Microphone unavailable" }
        synchronized(chunks) { chunks.clear() }
        record = rec
        running = true
        rec.startRecording()
        val maxSamples = maxDurationSec.toLong() * SAMPLE_RATE
        thread = Thread {
            val buf = ShortArray(SAMPLE_RATE / 20) // 50 ms
            var total = 0L
            while (running) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) continue
                val copy = buf.copyOf(n)
                synchronized(chunks) { chunks.add(copy) }
                total += n
                level = perceptualLevel(copy)
                if (total >= maxSamples) {
                    onAutoStop()
                    break
                }
            }
        }.apply {
            name = "murmur-recorder"
            start()
        }
    }

    fun stop(): ShortArray {
        stopInternal()
        val list = synchronized(chunks) { ArrayList(chunks).also { chunks.clear() } }
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
        synchronized(chunks) { chunks.clear() }
    }

    private fun stopInternal() {
        running = false
        level = 0f
        thread?.join(500)
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
