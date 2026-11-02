import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SttError, type TranscribeOutput } from '@core/stt'
import { defaultSettings, type Settings } from '@shared/settings'
import { layoutText, type AppCategory } from '@engine'

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
  /** Per request (1-based): how long it takes to answer, and whether it fails. */
  delays: {} as Record<number, number>,
  fail: new Set<number>(),
  transcribe: async (input: { wav: Uint8Array }): Promise<TranscribeOutput> => {
    const n = ++provider.requests
    provider.sizes.push(input.wav.length)
    if (provider.delays[n]) await new Promise((r) => setTimeout(r, provider.delays[n]))
    if (provider.fail.has(n)) throw new SttError('upstream 503', 'server')
    if (provider.failFirst && n === 1) throw new SttError('upstream 503', 'server')
    if (provider.outcome === 'timeout')
      throw new SttError('The request timed out after 45000 ms', 'timeout')
    return {
      text: `${provider.text} ${n}`,
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
  sampleCount(): number {
    return this.fed
  }
  /** Feeds the clip at `speed` times real time (100 ms chunks), as a slow-motion recording. */
  async feedPaced(speed = 50): Promise<void> {
    while (this.fed < this.pcm.length) {
      this.fed = Math.min(this.pcm.length, this.fed + 1600)
      this.emit('chunk', this.id, this.fed, 0.5)
      await new Promise((r) => setTimeout(r, 100 / speed))
    }
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
  /** Transcripts whose first formatting attempt fails. */
  failFormatOnce: new Set<string>(),
  formatter: async () => ({
    source: 'murmur',
    format: async (input: { transcript: string }) => {
      inference.formatCalls.push(input.transcript)
      await new Promise((r) => setTimeout(r, 2))
      if (inference.failFormatOnce.delete(input.transcript)) throw new Error('upstream 503')
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
    provider.delays = {}
    provider.fail = new Set()
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

  it('a failed piece is sent once more on its own, not the whole dictation', async () => {
    provider.failFirst = true
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 20))
    controller.handle({ type: 'stop' })
    await settle()
    const entry = history.list().entries[0]
    expect(entry.error).toBeUndefined()
    // Only the failed piece went up again: no request carries the whole 50 s clip.
    expect(Math.max(...provider.sizes)).toBeLessThan(recorder.pcm.length * 2 * 0.8)
  })

  it('a piece that fails twice is sent once more at release on its own, not the whole dictation', async () => {
    // Requests 1 and 2: the first piece and its retry while recording.
    provider.fail = new Set([1, 2])
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 20))
    controller.handle({ type: 'stop' })
    await settle()
    const entry = history.list().entries[0]
    expect(entry.error).toBeUndefined()
    expect(Math.max(...provider.sizes)).toBeLessThan(recorder.pcm.length * 2 * 0.8)
    expect(entry.finalText.length).toBeGreaterThan(0)
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

describe('a short dictation stopped in a pause (Android #134/#135)', () => {
  let dir: string
  let history: HistoryStore
  let controller: DictationController
  let recorder: FakeRecorder
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 400 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 5))
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-short-'))
    const recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(dir, recordings)
    inject.calls.length = 0
    provider.requests = 0
    provider.sizes = []
    provider.failFirst = false
    provider.delays = {}
    provider.fail = new Set()
    provider.outcome = 'ok'
    provider.text = 'short'
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

  /** 3 s of speech, then 1.5 s of quiet: the speaker stopped talking before letting go. */
  const spokeThenPaused = (): Int16Array => {
    const pcm = new Int16Array(Math.round(4.5 * SAMPLE_RATE))
    pcm.set(speech(3), 0)
    return pcm
  }

  it('uses the text transcribed in the pause; nothing more goes up at release', async () => {
    recorder.pcm = spokeThenPaused()
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 30))
    expect(provider.requests).toBe(1) // the speculation, while the user was still holding the key
    controller.handle({ type: 'stop' })
    await settle()
    expect(provider.requests).toBe(1)
    expect(history.list().entries[0].finalText.toLowerCase()).toContain('short 1')
  })

  it('skips the post-roll when the last moments were quiet', async () => {
    recorder.pcm = spokeThenPaused()
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    controller.handle({ type: 'stop' })
    await settle()
    expect(recorder.stop).toHaveBeenCalledWith(expect.any(String), expect.any(Number), {
      postRoll: false,
      quietDb: expect.any(Number)
    })
  })

  it('a dictation that went on after the pause is sent whole', async () => {
    const pcm = new Int16Array(Math.round(6 * SAMPLE_RATE))
    pcm.set(speech(3), 0)
    pcm.set(speech(2), Math.round(4 * SAMPLE_RATE))
    recorder.pcm = pcm
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 30))
    controller.handle({ type: 'stop' })
    await settle()
    // The speculation at 3 s, then the whole recording at release.
    expect(provider.requests).toBe(2)
    expect(Math.max(...provider.sizes)).toBeGreaterThan(5 * SAMPLE_RATE * 2)
    expect(history.list().entries[0].finalText.toLowerCase()).toContain('short 2')
  })
})

describe('a short dictation stopped in a pause: edge cases', () => {
  let dir: string
  let history: HistoryStore
  let controller: DictationController
  let recorder: FakeRecorder
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 600 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 5))
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const text = (): string => history.list().entries[0]?.finalText.toLowerCase() ?? ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-edge-'))
    const recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(dir, recordings)
    inject.calls.length = 0
    provider.requests = 0
    provider.sizes = []
    provider.failFirst = false
    provider.delays = {}
    provider.fail = new Set()
    provider.outcome = 'ok'
    provider.text = 'short'
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

  /** `parts` laid out in order: a number is that many seconds of silence, an array is speech. */
  const clip = (...parts: Array<number | [number]>): Int16Array => {
    const total = parts.reduce<number>((t, p) => t + (typeof p === 'number' ? p : p[0]), 0)
    const pcm = new Int16Array(Math.round(total * SAMPLE_RATE))
    let at = 0
    for (const p of parts) {
      const sec = typeof p === 'number' ? p : p[0]
      if (typeof p !== 'number') pcm.set(speech(sec), Math.round(at * SAMPLE_RATE))
      at += sec
    }
    return pcm
  }
  const dictate = async (pcm: Int16Array, holdMs = 30): Promise<void> => {
    recorder.pcm = pcm
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await sleep(holdMs)
    controller.handle({ type: 'stop' })
    await settle()
  }

  it('speculation still running at the stop: the whole recording wins when it is faster', async () => {
    provider.delays = { 1: 400 } // the background speculation is slow
    await dictate(clip([3], 1.5))
    expect(provider.requests).toBe(2)
    expect(text()).toContain('short 2')
  })

  it('speculation still running at the stop: it is used when it answers first', async () => {
    provider.delays = { 1: 60, 2: 600 }
    const t0 = Date.now()
    await dictate(clip([3], 1.5), 5)
    expect(text()).toContain('short 1')
    // Did not wait for the slow whole-recording request.
    expect(Date.now() - t0).toBeLessThan(550)
  })

  it('a failed speculation: the whole recording is sent at release', async () => {
    provider.fail = new Set([1])
    await dictate(clip([3], 1.5))
    expect(provider.requests).toBe(2)
    expect(text()).toContain('short 2')
  })

  it('a speculation that fails while the whole recording is in flight: the whole one decides', async () => {
    provider.delays = { 1: 80, 2: 200 }
    provider.fail = new Set([1])
    await dictate(clip([3], 1.5), 5)
    expect(text()).toContain('short 2')
  })

  it('both fail: the dictation ends with an error, not a hang', async () => {
    provider.delays = { 1: 50 }
    provider.fail = new Set([1, 2, 3, 4, 5, 6])
    await dictate(clip([3], 1.5), 5)
    expect(controller.isBusy).toBe(false)
    expect(inject.calls).toHaveLength(0)
  })

  it('a soft word after the speculation pause is still sent, not judged silent', async () => {
    // Speech over loud background noise (a high session noise floor), the noise stops for a
    // pause (the speculation is cut there), then a soft short word right before the stop.
    const pcm = clip([8], 1.0, 0.3)
    for (let i = 0; i < 8 * SAMPLE_RATE; i++)
      pcm[i] = Math.max(-32768, Math.min(32767, pcm[i] + Math.round((Math.random() - 0.5) * 3000)))
    const soft = Math.round(9.0 * SAMPLE_RATE)
    for (let i = 0; i < 0.3 * SAMPLE_RATE; i++)
      pcm[soft + i] = Math.round(Math.sin(i / 17) * 700 + (Math.random() - 0.5) * 40)
    await dictate(pcm)
    // The speculation, then the soft tail (or the whole recording): never the speculation alone.
    expect(provider.requests).toBeGreaterThan(1)
  })

  it('under 2 s of audio: no speculation, one request at release', async () => {
    await dictate(clip([1.2], 0.7))
    expect(provider.requests).toBe(1)
    expect(text()).toContain('short 1')
  })

  it('a stop 0.4 s into a pause: too short to speculate, still skips the post-roll', async () => {
    await dictate(clip([3], 0.4))
    expect(provider.requests).toBe(1)
    expect(recorder.stop).toHaveBeenCalledWith(expect.any(String), expect.any(Number), {
      postRoll: false,
      quietDb: expect.any(Number)
    })
  })

  it('a stop mid-word keeps the post-roll', async () => {
    await dictate(clip([3.17]))
    expect(recorder.stop).toHaveBeenCalledWith(expect.any(String), expect.any(Number), {
      postRoll: true
    })
  })

  it('a short word after the pause is never lost', async () => {
    await dictate(clip([3], 1, [0.3], 0.8))
    // The speculation covered the first 3 s; the word after it sends the whole recording again.
    expect(provider.requests).toBe(2)
    expect(text()).toContain('short 2')
    expect(Math.max(...provider.sizes)).toBeGreaterThan(4.5 * SAMPLE_RATE * 2)
  })

  it('a 60 ms click after the pause does not count as speech', async () => {
    const pcm = clip([3], 1.6)
    const at = Math.round(3.8 * SAMPLE_RATE)
    for (let i = 0; i < 0.06 * SAMPLE_RATE; i++) pcm[at + i] = Math.round(Math.sin(i / 3) * 12000)
    await dictate(pcm)
    expect(provider.requests).toBe(1)
    expect(text()).toContain('short 1')
  })

  it('spoke on for 3 s after the first pause, then paused again: the newer speculation is used', async () => {
    await dictate(clip([3], 1, [3], 1.5), 60)
    // One speculation per pause, nothing more at release.
    expect(provider.requests).toBe(2)
    expect(text()).toContain('short 2')
    expect(Math.max(...provider.sizes)).toBeGreaterThan(7 * SAMPLE_RATE * 2)
  })

  it('paced like a real recording: the second pause speculates again and the stop sends nothing', async () => {
    recorder.pcm = clip([3], 1, [3], 1.5)
    controller.handle({ type: 'start', mode: 'hold' })
    await recorder.feedPaced(20)
    await sleep(20)
    const before = provider.requests
    controller.handle({ type: 'stop' })
    await settle()
    expect(before).toBe(2)
    expect(provider.requests).toBe(2)
    expect(text()).toContain('short 2')
  })

  it('only one speculation at a time while the provider is behind', async () => {
    provider.delays = { 1: 300 }
    await dictate(clip([3], 1, [3], 1.5), 5)
    // The second pause found the first still running and did not pile on more of the same audio.
    expect(provider.sizes.filter((s) => s < 5 * SAMPLE_RATE * 2)).toHaveLength(1)
    expect(text()).toMatch(/short \d/)
    // The text covers the whole recording, never just the first stretch.
    expect(text()).not.toContain('short 1')
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
    provider.delays = {}
    provider.fail = new Set()
    provider.outcome = 'ok'
    provider.text = 'piece'
    inference.formatCalls.length = 0
    inference.failFormatOnce.clear()
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
  it('a piece whose formatting failed is formatted again alone, never the whole text', async () => {
    controller.handle({ type: 'start', mode: 'hold' })
    inference.failFormatOnce.add('piece 1')
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 30))
    controller.handle({ type: 'stop' })
    await settle()
    const text = history.list().entries[0].finalText
    // "piece 1" was formatted twice (the failure, then alone at release); no call had it all.
    expect(inference.formatCalls.filter((t) => t === 'piece 1')).toHaveLength(2)
    expect(inference.formatCalls.every((t) => t.split('piece').length <= 3)).toBe(true)
    expect(text).toContain('[piece 1]')
    expect(text).toContain('[piece 2]')
  })
  it('a long dictation gets paragraphs from a layout plan without a word changed', async () => {
    const sentence = 'We talked about the roadmap for the next quarter and what ships first.'
    provider.text = `${sentence} ${sentence} ${sentence} ${sentence} ${sentence} ${sentence} ${sentence} Part`
    const asked: string[] = []
    const orig = inference.formatter
    inference.formatter = (async () => ({
      ...(await orig()),
      layout: (text: string, category: AppCategory) =>
        layoutText(text, category, async (messages) => {
          asked.push(messages[1].content)
          return { text: '{"paragraphs":[6,12],"lists":[]}' }
        })
    })) as never
    try {
      controller.handle({ type: 'start', mode: 'hold' })
      recorder.feedAll()
      await new Promise((r) => setTimeout(r, 30))
      controller.handle({ type: 'stop' })
      await settle()
    } finally {
      inference.formatter = orig
    }
    const entry = history.list().entries[0]
    expect(asked).toHaveLength(1)
    expect(entry.stages).toContain('layout')
    expect(entry.finalText).toContain('\n\n')
    expect(entry.finalText.replace(/\s+/g, ' ')).toBe(entry.finalText.replace(/\n\n/g, ' '))
    // The pieces were laid out while recording; the tail joined that answer, never waited on.
    expect(asked[0]).not.toContain(`Part ${provider.requests}`)
    expect(entry.finalText).toMatch(new RegExp(`Part ${provider.requests}\\.?\\]?\\.?$`))
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
    provider.delays = {}
    provider.fail = new Set()
    provider.outcome = 'ok'
    provider.text = 'part'
    inference.formatCalls.length = 0
    inference.failFormatOnce.clear()
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
    // Speculation only runs after the first piece (~18 s). A 40 s clip with sentence pauses
    // cuts a piece, then speculates on the remainder.
    recorder.pcm = sentences(40)
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    await new Promise((r) => setTimeout(r, 40))
    const during = provider.requests
    expect(during).toBeGreaterThanOrEqual(1)
    controller.handle({ type: 'stop' })
    await settle()
    expect(provider.requests).toBe(during + 1)
    // Far less than the full clip goes up at release.
    expect(provider.sizes.at(-1)!).toBeLessThan(recorder.pcm.length * 2 * 0.5)
    const entry = history.list().entries[0]
    expect(entry.error).toBeUndefined()
    // Release STT is the last request; earlier ones were the piece and/or speculation.
    expect(entry.finalText.toLowerCase()).toContain(`part ${provider.requests}`)
    expect(entry.wordCount).toBeGreaterThan(0)
  })
})
