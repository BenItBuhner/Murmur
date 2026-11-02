/**
 * Live run of real clips through the desktop release path (the real DictationController, streamer
 * and speech requests; formatting is left out so only the speech path is timed). Each clip is fed
 * at real time in 100 ms chunks, as the overlay's recorder would, and the stop comes when the last
 * chunk is in. Prints stop-to-insert time and the text, with tail speculation on and off.
 *
 *   MURMUR_LIVE=1 MURMUR_BASE_URL=https://host/v1 MURMUR_API_KEY=... \
 *   MURMUR_STT_MODEL=murmur-fast-transcribe MURMUR_LIVE_CLIPS=/path/a.wav,/path/b.wav \
 *   MURMUR_LIVE_PAUSE_MS=1200 npm run test:live -- tests/live/release-path.test.ts
 *
 * Excluded from the default `npm test` run.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { decodeWavPcm16 } from '@core/audio/wav'
import { defaultSettings, type Settings } from '@shared/settings'

const inject = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; at: number }>,
  injectText: vi.fn(async (text: string, opts: { method: string }) => {
    inject.calls.push({ text, at: Date.now() })
    return { ok: true, method: opts.method === 'clipboard' ? 'clipboard' : 'paste', ms: 1 }
  }),
  readSelection: vi.fn(async () => ({ text: '', restore: () => undefined }))
}))
vi.mock('../../src/main/inject', () => ({
  injectText: inject.injectText,
  readSelection: inject.readSelection
}))

import { DictationController } from '../../src/main/dictation/session'
import { HistoryStore } from '../../src/main/store/history'
import { RecordingStore } from '../../src/main/store/recordings'

const baseUrl = process.env.MURMUR_BASE_URL ?? ''
const apiKey = process.env.MURMUR_API_KEY ?? ''
const model = process.env.MURMUR_STT_MODEL ?? 'murmur-fast-transcribe'
const pauseMs = Number(process.env.MURMUR_LIVE_PAUSE_MS ?? 1200)
const clips = (
  process.env.MURMUR_LIVE_CLIPS ?? resolve(__dirname, '../../resources/fixtures/jfk.wav')
)
  .split(',')
  .filter(Boolean)
const enabled = !!process.env.MURMUR_LIVE && !!baseUrl
const SAMPLE_RATE = 16000

class Settings_ extends EventEmitter {
  value: Settings = defaultSettings()
  constructor() {
    super()
    this.value.formatting.mode = 'light'
  }
  get(): Settings {
    return this.value
  }
  patch(p: Partial<Settings>): Settings {
    return (this.value = { ...this.value, ...p })
  }
}

/** Plays a clip as the overlay's recorder would: 100 ms chunks at real time. */
class PacedRecorder extends EventEmitter {
  pcm = new Int16Array(0)
  fed = 0
  id = ''
  start = (id: string): void => {
    this.id = id
  }
  cancel = (): void => undefined
  stop = async (): Promise<Int16Array> => this.pcm.slice(0, this.fed)
  read(_id: string, from: number): Int16Array {
    return this.pcm.slice(from, this.fed)
  }
  sampleCount(): number {
    return this.fed
  }
  async play(): Promise<void> {
    const t0 = Date.now()
    while (this.fed < this.pcm.length) {
      this.fed = Math.min(this.pcm.length, this.fed + 1600)
      this.emit('chunk', this.id, this.fed, 0.5)
      const due = t0 + (this.fed / SAMPLE_RATE) * 1000
      await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())))
    }
  }
}

const hook = {
  anyKeyDown: false,
  waitForKeysUp: async () => true,
  beginSynthetic: () => undefined,
  endSynthetic: () => undefined,
  notifySessionStarted: () => undefined,
  notifySessionEnded: () => undefined
}

const inference = {
  stt: async () => ({
    provider: 'murmur',
    source: 'custom',
    cfg: {
      kind: 'openai-compatible' as const,
      baseUrl,
      apiKey,
      model,
      language: 'en',
      timeoutMs: 45000,
      speed: 'normal' as const
    },
    fallbackModel: ''
  }),
  llm: async () => {
    throw new Error('no formatting model')
  },
  complete: async () => {
    throw new Error('no formatting model')
  },
  refreshedStt: async () => null,
  formatter: async () => ({ source: 'none', format: async () => null })
}

/** The clip, then `ms` of room tone (quiet noise, not digital silence) before the stop. */
function withPause(pcm: Int16Array, ms: number): Int16Array {
  const out = new Int16Array(pcm.length + Math.round((ms * SAMPLE_RATE) / 1000))
  out.set(pcm, 0)
  for (let i = pcm.length; i < out.length; i++) out[i] = Math.round((Math.random() - 0.5) * 40)
  return out
}

async function dictate(pcm: Int16Array): Promise<{ ms: number; text: string; requests: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-live-'))
  const recordings = new RecordingStore(join(dir, 'recordings'))
  const history = new HistoryStore(dir, recordings)
  const recorder = new PacedRecorder()
  recorder.pcm = pcm
  let requests = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    if (String(args[0]).includes('/audio/transcriptions')) requests++
    return realFetch(...args)
  }) as typeof fetch
  const controller = new DictationController({
    settings: new Settings_() as never,
    history,
    recorder: recorder as never,
    recordings,
    hook: hook as never,
    inference: inference as never,
    overlay: { setState: () => undefined, playSound: () => undefined },
    getActiveWindow: async () => ({ title: 'Notes', app: 'notes' })
  })
  inject.calls.length = 0
  try {
    controller.handle({ type: 'start', mode: 'hold' })
    await recorder.play()
    const stopAt = Date.now()
    controller.handle({ type: 'stop' })
    for (let i = 0; i < 3000 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 10))
    const call = inject.calls[0]
    return {
      ms: call ? call.at - stopAt : -1,
      text: call?.text ?? `(nothing: ${history.list().entries[0]?.error ?? 'no entry'})`,
      requests
    }
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!enabled)('live: desktop release path', () => {
  it('stop-to-insert with tail speculation on and off', { timeout: 30 * 60_000 }, async () => {
    const rows: string[] = []
    for (const file of clips) {
      const pcm = withPause(decodeWavPcm16(new Uint8Array(readFileSync(file))).pcm, pauseMs)
      for (const spec of ['on', 'off']) {
        vi.stubEnv('MURMUR_TAIL_SPECULATION', spec === 'on' ? '1' : '0')
        const r = await dictate(pcm)
        vi.unstubAllEnvs()
        rows.push(
          `${basename(file)} spec ${spec}: ${r.ms} ms, ${r.requests} speech request(s)\n    ${r.text}`
        )
        process.stdout.write(`LIVE ${rows[rows.length - 1]}\n`)
        expect(r.ms).toBeGreaterThan(0)
        // Space requests out so a real dictation on the same proxy is not slowed.
        await new Promise((res) => setTimeout(res, 1500))
      }
    }
  })
})
