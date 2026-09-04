package app.murmur.android.audio

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** PCM16 mono <-> WAV, matching the desktop core (apps/desktop/src/core/audio/wav.ts). */
object Wav {
    fun encodePcm16(pcm: ShortArray, sampleRate: Int): ByteArray {
        val dataSize = pcm.size * 2
        val buffer = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
        buffer.put("RIFF".toByteArray(Charsets.US_ASCII))
        buffer.putInt(36 + dataSize)
        buffer.put("WAVE".toByteArray(Charsets.US_ASCII))
        buffer.put("fmt ".toByteArray(Charsets.US_ASCII))
        buffer.putInt(16)
        buffer.putShort(1) // PCM
        buffer.putShort(1) // mono
        buffer.putInt(sampleRate)
        buffer.putInt(sampleRate * 2) // byte rate
        buffer.putShort(2) // block align
        buffer.putShort(16) // bits per sample
        buffer.put("data".toByteArray(Charsets.US_ASCII))
        buffer.putInt(dataSize)
        for (s in pcm) buffer.putShort(s)
        return buffer.array()
    }

    /** Minimal RIFF reader for the bundled fixture (PCM16 only; picks the first data chunk). */
    fun decodePcm16(wav: ByteArray): Pair<ShortArray, Int> {
        val buf = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        require(wav.size > 44 && wav.decodeToString(0, 4) == "RIFF") { "Not a WAV file" }
        var sampleRate = 16000
        var channels = 1
        var pos = 12
        var data: ShortArray? = null
        while (pos + 8 <= wav.size) {
            val id = wav.decodeToString(pos, pos + 4)
            val size = buf.getInt(pos + 4)
            val body = pos + 8
            when (id) {
                "fmt " -> {
                    channels = buf.getShort(body + 2).toInt()
                    sampleRate = buf.getInt(body + 4)
                }
                "data" -> {
                    val n = size / 2
                    val out = ShortArray(n)
                    for (i in 0 until n) out[i] = buf.getShort(body + i * 2)
                    data = out
                }
            }
            pos = body + size + (size and 1)
            if (data != null) break
        }
        val pcm = requireNotNull(data) { "WAV has no data chunk" }
        // Downmix to mono when needed.
        return if (channels <= 1) pcm to sampleRate
        else {
            val mono = ShortArray(pcm.size / channels)
            for (i in mono.indices) {
                var acc = 0
                for (c in 0 until channels) acc += pcm[i * channels + c]
                mono[i] = (acc / channels).toShort()
            }
            mono to sampleRate
        }
    }

    /** Nearest-sample resample; the fixture is only used for testing so quality is fine. */
    fun resample(pcm: ShortArray, from: Int, to: Int): ShortArray {
        if (from == to) return pcm
        val outLen = (pcm.size.toLong() * to / from).toInt()
        val out = ShortArray(outLen)
        for (i in 0 until outLen) out[i] = pcm[(i.toLong() * from / to).toInt().coerceAtMost(pcm.size - 1)]
        return out
    }

    fun peakDb(pcm: ShortArray): Double {
        var peak = 0
        for (s in pcm) {
            val a = if (s.toInt() == Short.MIN_VALUE.toInt()) Short.MAX_VALUE.toInt() else kotlin.math.abs(s.toInt())
            if (a > peak) peak = a
        }
        if (peak == 0) return -120.0
        return 20.0 * kotlin.math.log10(peak / 32767.0)
    }

    fun ByteArrayOutputStream.toShortArray(): ShortArray {
        val bytes = toByteArray()
        val out = ShortArray(bytes.size / 2)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(out)
        return out
    }
}
