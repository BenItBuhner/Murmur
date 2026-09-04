/** Encode mono 16-bit PCM as a RIFF/WAVE byte array. */
export function encodeWavPcm16(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataBytes, true)
  const out = new Uint8Array(buffer)
  // Int16Array views may not be 2-byte aligned relative to the ArrayBuffer start (offset 44 is fine).
  const target = new Int16Array(buffer, 44, pcm.length)
  target.set(pcm)
  return out
}

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  pcm: Int16Array
}

/** Minimal WAV reader for 16-bit PCM (used by tests and provider self-tests). */
export function decodeWavPcm16(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number): string =>
    String.fromCharCode(
      view.getUint8(o),
      view.getUint8(o + 1),
      view.getUint8(o + 2),
      view.getUint8(o + 3)
    )
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file')
  let offset = 12
  let sampleRate = 16000
  let channels = 1
  let bitsPerSample = 16
  let pcm: Int16Array | null = null
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      if (bitsPerSample !== 16) throw new Error(`Unsupported WAV bit depth ${bitsPerSample}`)
      const count = Math.floor(Math.min(size, view.byteLength - body) / 2)
      const src = new Int16Array(count)
      for (let i = 0; i < count; i++) src[i] = view.getInt16(body + i * 2, true)
      if (channels > 1) {
        const frames = Math.floor(count / channels)
        const mono = new Int16Array(frames)
        for (let f = 0; f < frames; f++) {
          let sum = 0
          for (let c = 0; c < channels; c++) sum += src[f * channels + c]
          mono[f] = Math.round(sum / channels)
        }
        pcm = mono
      } else {
        pcm = src
      }
    }
    offset = body + size + (size % 2)
  }
  if (!pcm) throw new Error('WAV has no data chunk')
  return { sampleRate, channels, bitsPerSample, pcm }
}

export function concatInt16(chunks: Int16Array[]): Int16Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Int16Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)
  }
  return out
}

/** Linear-interpolation resampler; only used when the AudioContext cannot run at 16 kHz natively. */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}
