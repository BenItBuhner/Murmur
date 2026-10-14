package app.murmur.android.audio

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Ogg Opus uploads for Murmur's gateway, matching the desktop (apps/desktop/src/core/audio/ogg-opus.ts).
 * 16 kbit/s Opus is ~19x smaller than 16 kHz PCM WAV at the same recognition accuracy, so a
 * five-minute dictation uploads ~0.5 MB instead of ~9 MB.
 */
object OggOpus {
    const val FRAME_16K = 320
    private const val PRE_SKIP = 312
    private const val PACKETS_PER_PAGE = 50
    private const val SERIAL = 0x4d524d52

    private val crcTable = IntArray(256).also { t ->
        for (i in 0 until 256) {
            var r = i shl 24
            repeat(8) { r = if ((r and 0x80000000.toInt()) != 0) (r shl 1) xor 0x04c11db7 else r shl 1 }
            t[i] = r
        }
    }

    private fun crc32(b: ByteArray): Int {
        var crc = 0
        for (x in b) crc = (crc shl 8) xor crcTable[((crc ushr 24) xor (x.toInt() and 0xff)) and 0xff]
        return crc
    }

    private fun page(packets: List<ByteArray>, granule: Long, seq: Int, flags: Int): ByteArray {
        val lacing = ArrayList<Int>()
        for (p in packets) {
            var n = p.size
            while (n >= 255) { lacing.add(255); n -= 255 }
            lacing.add(n)
        }
        val body = packets.sumOf { it.size }
        val buf = ByteBuffer.allocate(27 + lacing.size + body).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("OggS".toByteArray(Charsets.US_ASCII)).put(0).put(flags.toByte())
        buf.putLong(granule).putInt(SERIAL).putInt(seq).putInt(0).put(lacing.size.toByte())
        for (l in lacing) buf.put(l.toByte())
        for (p in packets) buf.put(p)
        val out = buf.array()
        ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN).putInt(22, crc32(out))
        return out
    }

    /** Wrap 20 ms mono Opus packets encoded from [inputRate] PCM in an Ogg Opus file. */
    fun mux(packets: List<ByteArray>, inputRate: Int = 16_000, samplesPerPacket: Int = FRAME_16K): ByteArray {
        require(packets.all { it.size < 255 * 254 }) { "Opus packet too large for one page" }
        val head = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN)
            .put("OpusHead".toByteArray(Charsets.US_ASCII)).put(1).put(1)
            .putShort(PRE_SKIP.toShort()).putInt(inputRate).putShort(0).put(0).array()
        val vendor = "murmur".toByteArray(Charsets.US_ASCII)
        val tags = ByteBuffer.allocate(16 + vendor.size).order(ByteOrder.LITTLE_ENDIAN)
            .put("OpusTags".toByteArray(Charsets.US_ASCII)).putInt(vendor.size).put(vendor).putInt(0).array()
        val out = ByteArrayOutputStream()
        out.write(page(listOf(head), 0, 0, 0x02))
        out.write(page(listOf(tags), 0, 1, 0))
        val step = samplesPerPacket.toLong() * 48_000 / inputRate
        var granule = PRE_SKIP.toLong()
        var seq = 2
        var i = 0
        while (i < packets.size) {
            val group = packets.subList(i, minOf(i + PACKETS_PER_PAGE, packets.size))
            granule += group.size * step
            i += PACKETS_PER_PAGE
            out.write(page(group, granule, seq++, if (i >= packets.size) 0x04 else 0))
        }
        return out.toByteArray()
    }

    /**
     * 16 kbit/s Ogg Opus from a 16 kHz mono PCM WAV, or null (send the WAV) when the device has no
     * Opus encoder (Android 9 and older), the clip is not 16 kHz, or anything about encoding fails.
     */
    fun fromWav(wav: ByteArray): ByteArray? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        return try {
            val (pcm, rate) = Wav.decodePcm16(wav)
            if (rate != 16_000 || pcm.size < 1600) return null
            val packets = encode(pcm) ?: return null
            // Every 20 ms frame must come back as one packet; anything else is an encoder we do not trust.
            val frames = (pcm.size + FRAME_16K - 1) / FRAME_16K
            if (packets.size < frames - 2 || packets.size > frames + 4) return null
            mux(packets)
        } catch (_: Throwable) {
            null
        }
    }

    private fun encode(pcm: ShortArray): List<ByteArray>? {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 16_000, 1).apply {
            setInteger(MediaFormat.KEY_BIT_RATE, 16_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, FRAME_16K * 2)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
        val packets = ArrayList<ByteArray>()
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val info = MediaCodec.BufferInfo()
            val bytes = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            for (s in pcm) bytes.putShort(s)
            val raw = bytes.array()
            var offset = 0
            var inputDone = false
            var outputDone = false
            var idle = 0
            while (!outputDone) {
                if (!inputDone) {
                    val idx = codec.dequeueInputBuffer(10_000)
                    if (idx >= 0) {
                        val buf = codec.getInputBuffer(idx)!!
                        buf.clear()
                        val n = minOf(FRAME_16K * 2, raw.size - offset, buf.remaining())
                        val ptsUs = offset / 2L * 1_000_000 / 16_000
                        if (n <= 0) {
                            codec.queueInputBuffer(idx, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            buf.put(raw, offset, n)
                            codec.queueInputBuffer(idx, 0, n, ptsUs, 0)
                            offset += n
                        }
                    }
                }
                val out = codec.dequeueOutputBuffer(info, 10_000)
                if (out >= 0) {
                    idle = 0
                    val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                    if (!isConfig && info.size > 0) {
                        val buf = codec.getOutputBuffer(out)!!
                        buf.position(info.offset).limit(info.offset + info.size)
                        packets.add(ByteArray(info.size).also { buf.get(it) })
                    }
                    codec.releaseOutputBuffer(out, false)
                    if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true
                } else if (inputDone && ++idle > 300) {
                    return null // ~3 s without output after end of input: give up, send WAV
                }
            }
        } finally {
            try { codec.stop() } catch (_: Throwable) {}
            codec.release()
        }
        return packets
    }
}
