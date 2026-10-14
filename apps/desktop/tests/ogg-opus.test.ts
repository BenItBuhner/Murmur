import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeOggOpus, muxOggOpus } from '@core/audio/ogg-opus'
import { encodeWavPcm16 } from '@core/audio/wav'
import { OpenAiCompatibleStt, setCompactUploadEncoder } from '@core/stt/openai-compatible'
import type { SttConfig } from '@core/stt/types'
import { wavToOggOpus } from '../src/main/audio/opus'

function pages(
  bytes: Uint8Array
): Array<{ granule: number; flags: number; at: number; len: number }> {
  const out: Array<{ granule: number; flags: number; at: number; len: number }> = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  while (at < bytes.length) {
    expect(String.fromCharCode(...bytes.subarray(at, at + 4))).toBe('OggS')
    const n = bytes[at + 26]
    let body = 0
    for (let i = 0; i < n; i++) body += bytes[at + 27 + i]
    const len = 27 + n + body
    out.push({ granule: view.getUint32(at + 6, true), flags: bytes[at + 5], at, len })
    at += len
  }
  return out
}

const tone = (seconds: number): Int16Array => {
  const pcm = new Int16Array(16_000 * seconds)
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 7) * 6000)
  return pcm
}

describe('Ogg Opus upload', () => {
  it('frames packets into valid pages whose last granule is the clip length', () => {
    const packets = Array.from({ length: 120 }, () => new Uint8Array(40).fill(7))
    const file = muxOggOpus(packets, 16_000)
    const ps = pages(file)
    expect(ps[0].flags).toBe(0x02)
    expect(String.fromCharCode(...file.subarray(28, 36))).toBe('OpusHead')
    expect(ps.at(-1)!.flags).toBe(0x04)
    // 120 packets x 20 ms = 2.4 s; granule counts 48 kHz samples plus the 312-sample pre-skip.
    expect(ps.at(-1)!.granule - 312).toBe(2.4 * 48_000)
  })

  it('zero-pads the final partial frame', () => {
    const frames: number[] = []
    encodeOggOpus(new Int16Array(700), (f) => {
      frames.push(f.length)
      return new Uint8Array(3)
    })
    expect(frames).toEqual([320, 320, 320])
  })

  it('encodes a real 16 kHz WAV about 15x smaller', () => {
    const wav = encodeWavPcm16(tone(5), 16_000)
    const ogg = wavToOggOpus(wav)
    expect(ogg).not.toBeNull()
    expect(ogg!.length * 10).toBeLessThan(wav.length)
    const last = pages(ogg!).at(-1)!
    expect((last.granule - 312) / 48_000).toBeCloseTo(5, 1)
  })

  it('leaves clips it cannot encode as WAV', () => {
    expect(wavToOggOpus(encodeWavPcm16(tone(1), 44_100))).toBeNull()
    expect(wavToOggOpus(new Uint8Array(10))).toBeNull()
  })
})

describe('compact upload in the OpenAI-compatible provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setCompactUploadEncoder(null)
  })
  const wav = encodeWavPcm16(tone(1), 16_000)
  const cfg = (baseUrl: string, speed?: 'normal' | 'fast'): SttConfig => ({
    kind: 'openai-compatible',
    baseUrl,
    apiKey: 'k',
    model: 'murmur-transcribe',
    language: 'auto',
    timeoutMs: 5000,
    speed
  })
  function serve(statuses: number[]): string[] {
    const types: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        const file = (init.body as FormData).get('file') as File
        types.push(file.type)
        const status = statuses.shift() ?? 200
        return new Response(
          JSON.stringify(status === 200 ? { text: 'ok' } : { error: 'unsupported audio' }),
          {
            status,
            headers: { 'content-type': 'application/json' }
          }
        )
      })
    )
    return types
  }

  it('sends Opus to the Murmur gateway only', async () => {
    setCompactUploadEncoder(wavToOggOpus)
    const types = serve([200, 200])
    await new OpenAiCompatibleStt().transcribe({ wav }, cfg('https://gw.example/v1', 'fast'))
    await new OpenAiCompatibleStt().transcribe({ wav }, cfg('https://own.example/v1'))
    expect(types).toEqual(['audio/ogg', 'audio/wav'])
  })

  it('falls back to WAV, and stays on it, when the gateway refuses Opus', async () => {
    setCompactUploadEncoder(wavToOggOpus)
    const types = serve([400, 200, 200])
    const out = await new OpenAiCompatibleStt().transcribe(
      { wav },
      cfg('https://old.example/v1', 'normal')
    )
    expect(out.text).toBe('ok')
    await new OpenAiCompatibleStt().transcribe({ wav }, cfg('https://old.example/v1', 'normal'))
    expect(types).toEqual(['audio/ogg', 'audio/wav', 'audio/wav'])
  })
})
