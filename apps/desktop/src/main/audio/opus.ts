import OpusScript from 'opusscript'
import { decodeWavPcm16 } from '@core/audio/wav'
import { encodeOggOpus } from '@core/audio/ogg-opus'

/**
 * The upload for Murmur's gateway: 16 kbit/s Ogg Opus when the clip is 16 kHz mono PCM WAV, else
 * null so the caller sends the WAV unchanged.
 */
export function wavToOggOpus(wav: Uint8Array): Uint8Array | null {
  let encoder: OpusScript | null = null
  try {
    const info = decodeWavPcm16(wav)
    if (info.sampleRate !== 16_000 || info.channels !== 1 || info.pcm.length < 1600) return null
    encoder = new OpusScript(16_000, 1, OpusScript.Application.VOIP)
    encoder.setBitrate(16_000)
    const enc = encoder
    return encodeOggOpus(info.pcm, (frame) => {
      const buf = enc.encode(
        Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
        frame.length
      )
      return new Uint8Array(buf)
    })
  } catch {
    return null
  } finally {
    encoder?.delete()
  }
}
