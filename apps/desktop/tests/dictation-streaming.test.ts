import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SttError, type TranscribeOutput } from '@core/stt'
import { defaultSettings, type Settings } from '@shared/settings'

// The session talks to the desktop through the injector (Electron's clipboard and native key
// synthesis) and the speech provider (HTTP). Both are replaced; everything else is the real code.
const inject = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; method: string }>,
  injectText: vi.fn(async (text: string, opts: { method: string }) => {
    inject.calls.push({ text, method: opts.method })
    return { ok: true, method: opts.method === 'clipboard' ? 'clipboard' : 'paste', ms: 1 }
  }),
  readSelection: vi.fn(async () => ({ text: '', restore: () => undefined }))
}))
vi.mock('../src/main/inject', () => ({
  injectText: inject.injectText,
  readSelection: inject.readSelection
}))

const provider = vi.hoisted(() => ({
  requests: 0,
  /** What the next transcription requests do: fail like a slow server, or answer. */
  outcome: 'timeout' as 'timeout' | 'ok',
  text: 'um so hello from murmur this is a test',
  sizes: [] as number[],
  failFirst: false,
  transcribe: async (input: { wav: Uint8Array }): Promise<TranscribeOutput> => {
    provider.requests++
    provider.sizes.push(input.wav.length)
    if (provider.failFirst && provider.requests === 1) throw new SttError('upstream 503', 'server')
    if (provider.outcome === 'timeout')
      throw new SttError('The request timed out after 45000 ms', 'timeout')
    return {
      text: `${provider.text} ${provider.requests}`,
      language: 'en',
      durationSec: 1.5,
      latencyMs: 12
    }
  }
}))
vi.mock('@core/stt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/stt')>()
  return {
    ...actual,
    getSttProvider: () => ({
      transcribe: provider.transcribe,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' })
    })
  }
})

import { DictationController } from '../src/main/dictation/session'
import { HistoryStore } from '../src/main/store/history'
import { RecordingStore } from '../src/main/store/recordings'

const SAMPLE_RATE = 16000

/** Speech-shaped audio: loud bursts over a quiet floor, so the adaptive VAD finds both. */
function speech(seconds: number): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SAMPLE_RATE
    const voiced = t % 0.5 < 0.35
    const amplitude = voiced ? 11000 : 60
    pcm[i] = Math.round(Math.sin(i / 17) * amplitude + (Math.random() - 0.5) * 40)
  }
  return pcm
}

class FakeSettings extends EventEmitter {
  value: Settings = defaultSettings()
  constructor() {
    super()
    // The user's own provider, rule-based formatting only: no formatting model in this test.
    this.value.stt.source = 'custom'
    this.value.stt.baseUrl = 'http://stt.test/v1'
    this.value.stt.model = 'whisper-1'
    this.value.formatting.mode = 'light'
  }
  get(): Settings {
    return this.value
  }
  patch(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch }
    return this.value
  }
}

/** Speech with a clear 0.8 s pause every 4 s, like sentences. */
function sentences(seconds: number): Int16Array {
  const pcm = speech(seconds)
  for (let s = 3.4; s < seconds; s += 4)
    pcm.fill(0, Math.round(s * SAMPLE_RATE), Math.round((s + 0.8) * SAMPLE_RATE))
  return pcm
}

/** Streams its clip as the renderer would: 100 ms chunks with 'chunk' events. */
class FakeRecorder extends EventEmitter {
  pcm = sentences(50)
  fed = 0
  id = ''
  start = vi.fn((id: string) => {
    this.id = id
  })
  cancel = vi.fn()
  stop = vi.fn(async () => this.pcm.slice(0, this.fed))
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

const hook = {
  waitForKeysUp: async () => true,
  beginSynthetic: () => undefined,
  endSynthetic: () => undefined,
  notifySessionStarted: () => undefined,
  notifySessionEnded: () => undefined
}

const inference = {
  stt: async () => ({
    provider: 'murmur',
    cfg: {
      kind: 'openai-compatible' as const,
      baseUrl: 'http://stt.test/v1',
      apiKey: '',
      model: 'whisper-1',
      language: 'auto',
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
  formatCalls: [] as string[],
  formatter: async () => ({
    source: 'murmur',
    format: async (input: { transcript: string }) => {
      inference.formatCalls.push(input.transcript)
      await new Promise((r) => setTimeout(r, 2))
      return {
        text: `[${input.transcript}]`,
        pressEnter: false,
        llmMs: 3,
        status: { outcome: 'used', attempts: 1 },
        stages: ['llm']
      }
    }
  })
}

describe('streaming a long dictation while it is spoken', () => {
  beforeEach(() => vi.stubEnv('MURMUR_TAIL_SPECULATION', '0'))
  afterEach(() => vi.unstubAllEnvs())
  let dir: string
  let history: HistoryStore
  let controller: DictationController
  let recorder: FakeRecorder
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 400 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 5))
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-stream-'))
    const recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(dir, recordings)
    inject.calls.length = 0
    provider.requests = 0
    provider.sizes = []
    provider.failFirst = false
    provider.outcome = 'ok'
    provider.text = 'piece'
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

  it('sends finished stretches during recording and only the rest at release', async () => {
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 20))
    const duringRecording = provider.requests
    expect(duringRecording).toBeGreaterThanOrEqual(2)
    controller.handle({ type: 'stop' })
    await settle()
    expect(provider.requests).toBe(duringRecording + 1)
    // The upload after release is the tail alone, far smaller than the 50 s clip.
    const last = provider.sizes.at(-1)!
    expect(last).toBeLessThan(recorder.pcm.length * 2 * 0.5)
    const text = history.list().entries[0].finalText
    for (let i = 1; i <= provider.requests; i++) expect(text).toContain(`${i}`)
  })

  it('a failed piece falls back to one whole upload', async () => {
    provider.failFirst = true
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 20))
    controller.handle({ type: 'stop' })
    await settle()
    const entry = history.list().entries[0]
    expect(entry.error).toBeUndefined()
    // The whole 50 s clip went up once more after the failure.
    expect(Math.max(...provider.sizes)).toBeGreaterThan(recorder.pcm.length * 2 * 0.8)
  })

  it('a short dictation is one request, as before', async () => {
    recorder.pcm = sentences(8)
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    controller.handle({ type: 'stop' })
    await settle()
    expect(provider.requests).toBe(1)
  })
})

describe('precision mode formats pieces while the user speaks', () => {
  beforeEach(() => vi.stubEnv('MURMUR_TAIL_SPECULATION', '0'))
  afterEach(() => vi.unstubAllEnvs())
  let dir: string
  let history: HistoryStore
  let controller: DictationController
  let recorder: FakeRecorder
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 400 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 5))
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-spec-'))
    const recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(dir, recordings)
    provider.requests = 0
    provider.sizes = []
    provider.failFirst = false
    provider.outcome = 'ok'
    provider.text = 'piece'
    inference.formatCalls.length = 0
    recorder = new FakeRecorder()
    const settings = new FakeSettings()
    settings.value.formatting.mode = 'smart'
    controller = new DictationController({
      settings: settings as never,
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

  it('formats each piece during recording and only the tail at release', async () => {
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 30))
    const before = inference.formatCalls.length
    expect(before).toBeGreaterThanOrEqual(2)
    controller.handle({ type: 'stop' })
    await settle()
    // The tail is two words after formatted text: rules format it, so no model call at release,
    // and never one for the whole transcript.
    expect(inference.formatCalls.length).toBe(before)
    const text = history.list().entries[0].finalText
    for (let i = 1; i < provider.requests; i++) expect(text).toContain(`[piece ${i}]`)
    expect(text).toMatch(new RegExp(`Piece ${provider.requests}\\.?$`))
  })
})

describe('speculating on the tail while the user speaks', () => {
  let dir: string
  let history: HistoryStore
  let controller: DictationController
  let recorder: FakeRecorder
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 400 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 5))
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-tail-'))
    const recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(dir, recordings)
    provider.requests = 0
    provider.sizes = []
    provider.failFirst = false
    provider.outcome = 'ok'
    provider.text = 'part'
    inference.formatCalls.length = 0
    recorder = new FakeRecorder()
    const settings = new FakeSettings()
    settings.value.formatting.mode = 'smart'
    controller = new DictationController({
      settings: settings as never,
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

  it('sends only the words after the last pause at release', async () => {
    recorder.pcm = sentences(12)
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 40))
    const during = provider.requests
    expect(during).toBeGreaterThanOrEqual(1)
    controller.handle({ type: 'stop' })
    await settle()
    expect(provider.requests).toBe(during + 1)
    // Far less than the 12 s clip goes up at release.
    expect(provider.sizes.at(-1)!).toBeLessThan(recorder.pcm.length * 2 * 0.5)
    const entry = history.list().entries[0]
    expect(entry.error).toBeUndefined()
    // The latest speculation and the words after it, nothing from superseded speculations.
    expect(entry.finalText).toContain(`part ${provider.requests}`)
    expect(entry.finalText).toContain(`part ${during}`)
    for (let i = 1; i < during; i++) expect(entry.finalText).not.toContain(`part ${i}]`)
  })
})
