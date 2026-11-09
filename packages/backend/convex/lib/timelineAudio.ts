/**
 * Server-side analysis of an all-day recording piece: loudness and share of speech from the WAV, and
 * how worth keeping it is. Clients only send audio; everything about what it means happens here.
 */

const IDEA =
  /\b(idea|what if|we could|i should|i want to|remind me|note to self|don'?t forget|maybe we)\b/i

/** PCM16 samples and rate from a WAV (the "data" chunk), or null when it is not one. */
export function readWav(bytes: Uint8Array): { pcm: Int16Array; rate: number } | null {
  if (bytes.length < 44) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number): string =>
    String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!)
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let rate = 16_000
  let o = 12
  while (o + 8 <= bytes.length) {
    const id = tag(o)
    const size = dv.getUint32(o + 4, true)
    if (id === 'fmt ') rate = dv.getUint32(o + 12, true)
    if (id === 'data') {
      const len = Math.floor(Math.min(size, bytes.length - o - 8) / 2)
      const pcm = new Int16Array(len)
      for (let i = 0; i < len; i++) pcm[i] = dv.getInt16(o + 8 + i * 2, true)
      return { pcm, rate }
    }
    o += 8 + size + (size % 2)
  }
  return null
}

/** Mean loudness (dBFS) and share of 50 ms frames above speech level. */
export function audioStats(pcm: Int16Array, rate: number): { rmsDb: number; speechRatio: number } {
  const frame = Math.max(1, Math.floor(rate / 20))
  let frames = 0
  let loud = 0
  let sum = 0
  for (let f = 0; f + frame <= pcm.length; f += frame) {
    let acc = 0
    for (let k = f; k < f + frame; k++) acc += (pcm[k]! / 32768) ** 2
    const db = 20 * Math.log10(Math.max(1e-6, Math.sqrt(acc / frame)))
    sum += db
    frames++
    if (db > -45) loud++
  }
  if (!frames) return { rmsDb: -90, speechRatio: 0 }
  return {
    rmsDb: Math.round((sum / frames) * 10) / 10,
    speechRatio: Math.round((loud / frames) * 100) / 100
  }
}

/** How worth keeping a piece is, 0..1, and why (same rules as Ephemeris's timeline). */
export function scorePiece(p: {
  text: string
  seconds: number
  rmsDb: number
  speechRatio: number
}): { score: number; tags: string[] } {
  const tags: string[] = []
  const words = p.text.trim() ? p.text.trim().split(/\s+/).length : 0
  const secs = Math.max(1, p.seconds)
  const loudness = Math.min(1, Math.max(0, (p.rmsDb + 60) / 40))
  let score = 0.45 * p.speechRatio + 0.2 * loudness + 0.2 * Math.min(1, words / (secs * 1.5))
  if (p.speechRatio > 0.3) tags.push('speech')
  if (IDEA.test(p.text)) {
    score += 0.2
    tags.push('idea')
  }
  return { score: Math.min(1, Math.round(score * 100) / 100), tags }
}
