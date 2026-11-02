import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscribeOutput } from '@core/stt'
import { defaultSettings, type Settings } from '@shared/settings'

// The one-call release (speech + formatting of the tail on Murmur's gateway) gets the same
// "did the transcript reach the end of the speech" check as every other speech request.

vi.mock('../src/main/inject', () => ({
  injectText: vi.fn(async () => ({ ok: true, method: 'paste', ms: 1 })),
  readSelection: vi.fn(async () => ({ text: '', restore: () => undefined }))
}))

const SAMPLE_RATE = 16000
const net = vi.hoisted(() => ({
  released: false,
  /** Seconds of the tail the one-call answer's word timings reach; null: all of it. */
  releaseStopsAt: null as number | null,
  releaseCalls: 0,
  resumes: [] as number[],
  pieces: 0
}))

const clipSec = (wav: Uint8Array): number => (wav.length - 44) / 2 / 16000

vi.mock('@core/stt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/stt')>()
  return {
    ...actual,
    getSttProvider: () => ({
      transcribe: async (input: { wav: Uint8Array }): Promise<TranscribeOutput> => {
        const sec = clipSec(input.wav)
        if (net.released) net.resumes.push(sec)
        else net.pieces++
        const text = net.released
          ? 'and the rest of what I said'
          : `Something came first. Then piece ${net.pieces} words here`
        return {
          text,
          language: 'en',
          durationSec: sec,
          latencyMs: 1,
          spans: [{ start: 0, end: sec }]
        }
      },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' })
    })
  }
})

vi.mock('@core/stt/openai-compatible', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/stt/openai-compatible')>()
  return {
    ...actual,
    prewarmGateway: async () => undefined,
    dictateRelease: async (input: { wav: Uint8Array }, _cfg: unknown, prefix?: string) => {
      net.releaseCalls++
      const sec = clipSec(input.wav)
      const end = net.releaseStopsAt ?? sec
      const text = 'the tail begins'
      const transcript = `${prefix ?? ''} ${text}`.trim()
      return {
        stt: { text, language: 'en', durationSec: sec, latencyMs: 1, spans: [{ start: 0, end }] },
        transcript,
        format: {
          text: `GATEWAY ${transcript}`,
          pressEnter: false,
          llmMs: 1,
          status: { outcome: 'used', attempts: 1 },
          stages: ['llm']
        },
        rules: false
      }
    }
  }
})

import { DictationController } from '../src/main/dictation/session'
import { HistoryStore } from '../src/main/store/history'
import { RecordingStore } from '../src/main/store/recordings'

/** Talk with a pause every 4 s, then `run` seconds of talk without a pause (the tail). */
function talk(seconds: number, run: number): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SAMPLE_RATE
    const voiced = t % 0.5 < 0.35
    pcm[i] = Math.round(Math.sin(i / 17) * (voiced ? 11000 : 60) + (Math.random() - 0.5) * 40)
  }
  for (let s = 3.4; s < seconds - run; s += 4)
    pcm.fill(0, Math.round(s * SAMPLE_RATE), Math.round((s + 0.8) * SAMPLE_RATE))
  return pcm
}

class FakeRecorder extends EventEmitter {
  pcm = talk(32, 6)
  fed = 0
  id = ''
  start = (id: string): void => {
    this.id = id
  }
  cancel = (): void => undefined
  stop = async (): Promise<Int16Array> => this.pcm.subarray(0, this.fed)
  read(_id: string, from: number): Int16Array {
    return this.pcm.slice(from, this.fed)
  }
  feedAll(): void {
    while (this.fed < this.pcm.length) {
      this.fed = Math.min(this.pcm.length, this.fed + 1600)
      this.emit('chunk', this.id, this.fed, 0.5)
    }
  }
}

class FakeSettings extends EventEmitter {
  value: Settings = defaultSettings()
  constructor() {
    super()
    this.value.formatting.mode = 'smart'
  }
  get(): Settings {
    return this.value
  }
  patch(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch }
    return this.value
  }
}

const formatter = {
  source: 'murmur',
  format: async (input: { transcript: string }) => ({
    text: `[${input.transcript}]`,
    pressEnter: false,
    llmMs: 1,
    status: { outcome: 'used', attempts: 1 },
    stages: ['llm']
  })
}

const inference = {
  routing: () => ({ stt: 'murmur', llm: 'murmur' }),
  stt: async () => ({
    source: 'murmur',
    provider: 'murmur',
    cfg: {
      kind: 'openai-compatible' as const,
      baseUrl: 'http://stt.test/v1',
      apiKey: '',
      model: 'murmur'
    },
    fallbackModel: ''
  }),
  llm: async () => {
    throw new Error('no model')
  },
  complete: async () => {
    throw new Error('no model')
  },
  refreshedStt: async () => null,
  formatter: async () => formatter
}

const hook = {
  waitForKeysUp: async () => true,
  beginSynthetic: () => undefined,
  endSynthetic: () => undefined,
  notifySessionStarted: () => undefined,
  notifySessionEnded: () => undefined
}

describe('the one-call release checks that the tail was transcribed to its end', () => {
  let dir: string
  let history: HistoryStore
  let controller: DictationController
  let recorder: FakeRecorder
  beforeEach(() => {
    Object.assign(net, {
      released: false,
      releaseStopsAt: null,
      releaseCalls: 0,
      resumes: [],
      pieces: 0
    })
    dir = mkdtempSync(join(tmpdir(), 'murmur-cov-'))
    const recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(dir, recordings)
    recorder = new FakeRecorder()
    controller = new DictationController({
      settings: new FakeSettings() as never,
      history,
      recorder: recorder as never,
      recordings,
      hook: hook as never,
      inference: inference as never,
      overlay: { setState: () => undefined, playSound: () => undefined },
      getActiveWindow: async () => ({ title: 'Notes', app: 'notes' })
    })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const dictate = async (): Promise<string> => {
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 300))
    net.released = true
    controller.handle({ type: 'stop' })
    for (let i = 0; i < 400 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 5))
    return history.list().entries[0].finalText
  }

  it('a tail transcribed to its end is used as the gateway formatted it', async () => {
    const text = await dictate()
    expect(net.releaseCalls).toBe(1)
    expect(net.resumes).toHaveLength(0)
    expect(text).toContain('GATEWAY')
  })

  it('a tail whose transcript stopped early is resumed from where it stopped', async () => {
    net.releaseStopsAt = 0.8
    const text = await dictate()
    expect(net.releaseCalls).toBe(1)
    // Only the audio after the stop goes up again, not the whole tail.
    expect(net.resumes.length).toBeGreaterThanOrEqual(1)
    expect(text).toContain('the rest of what I said')
    expect(text).toContain('the tail begins')
    // The gateway formatted the cut-off text; that answer is not used.
    expect(text).not.toContain('GATEWAY')
  })
})
