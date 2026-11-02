import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscribeOutput } from '@core/stt'
import { defaultSettings, type Settings } from '@shared/settings'

/**
 * Cut-off endings, end to end: every dictation here is a run of "words", each a tone of its own
 * pitch, and the fake speech model writes down the words whose tones reach it. So the inserted text
 * holds the last word only if the audio of the last word made it through the whole stop path:
 * the recorder, trimming, speculation, the streamed pieces, the tail and the seams. The real
 * session code runs; only the injector and the speech provider are replaced.
 */

const SAMPLE_RATE = 16000
const WORDS = (
  'apple river candle forest window garden silver orange planet bridge yellow castle ' +
  'pencil marble ticket rocket violet copper meadow lantern harbor cotton spider ' +
  'velvet pepper basket mirror falcon jacket timber anchor saddle cobalt walnut ' +
  'button canyon dragon puzzle'
).split(' ')
/** Word i is a sine at this pitch: far enough apart to tell by zero crossings. */
const pitch = (i: number): number => 260 + 60 * i

const inject = vi.hoisted(() => ({
  calls: [] as string[],
  injectText: vi.fn(async (text: string, opts: { method: string }) => {
    inject.calls.push(text)
    return { ok: true, method: opts.method === 'clipboard' ? 'clipboard' : 'paste', ms: 1 }
  }),
  readSelection: vi.fn(async () => ({ text: '', restore: () => undefined }))
}))
vi.mock('../src/main/inject', () => ({
  injectText: inject.injectText,
  readSelection: inject.readSelection
}))

const heard = vi.hoisted(() => ({
  /** Turns a request's audio into the words it holds (set below, once WORDS exist). */
  decode: (() => []) as (pcm: Int16Array) => string[],
  requests: 0
}))
vi.mock('@core/stt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/stt')>()
  return {
    ...actual,
    getSttProvider: () => ({
      transcribe: async (input: { wav: Uint8Array }): Promise<TranscribeOutput> => {
        heard.requests++
        const bytes = input.wav.slice(44)
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2))
        const words = heard.decode(pcm)
        await new Promise((r) => setTimeout(r, 3))
        return {
          text: words.join(' '),
          language: 'en',
          durationSec: pcm.length / 16000,
          latencyMs: 3
        }
      },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' })
    })
  }
})

import { DictationController } from '../src/main/dictation/session'
import { HistoryStore } from '../src/main/store/history'
import { RecordingStore } from '../src/main/store/recordings'

/** Voiced runs (20 ms frames over the clip's floor, 60 ms or longer), each named by its pitch. */
heard.decode = (pcm: Int16Array): string[] => {
  const frame = 320
  const out: string[] = []
  let runStart = -1
  const close = (end: number): void => {
    if (runStart < 0) return
    const len = end - runStart
    if (len >= 960) {
      // Sign changes between samples clear of the noise floor, timed from the first to the last.
      let crossings = 0,
        sign = 0,
        first = -1,
        last = -1
      let peak = 0
      for (let i = runStart; i < end; i++) peak = Math.max(peak, Math.abs(pcm[i]))
      const band = Math.max(150, 0.5 * peak)
      for (let i = runStart; i < end; i++) {
        const sgn = pcm[i] > band ? 1 : pcm[i] < -band ? -1 : 0
        if (!sgn) continue
        if (sign && sgn !== sign) {
          crossings++
          if (first < 0) first = i
          last = i
        }
        sign = sgn
      }
      const hz = last > first ? ((crossings - 1) / 2) * (SAMPLE_RATE / (last - first)) : 0
      const i = Math.round((hz - 260) / 60)
      if (i >= 0 && i < WORDS.length) out.push(WORDS[i])
    }
    runStart = -1
  }
  const levels: number[] = []
  for (let f = 0; f + frame <= pcm.length; f += frame) {
    let sum = 0
    for (let i = f; i < f + frame; i++) sum += pcm[i] * pcm[i]
    levels.push(20 * Math.log10(Math.sqrt(sum / frame) / 32768 + 1e-9))
  }
  // Voiced = 10 dB over the clip's own floor (its quietest fifth), and never under -45 dBFS.
  const sorted = [...levels].sort((a, b) => a - b)
  const bar = Math.max(-45, (sorted[Math.floor(sorted.length * 0.2)] ?? -90) + 10)
  levels.forEach((db, k) => {
    if (db > bar) {
      if (runStart < 0) runStart = k * frame
    } else close(k * frame)
  })
  close(pcm.length - (pcm.length % frame))
  return out
}

interface Part {
  /** A word (index into WORDS), or a pause in seconds. */
  word?: number
  pause?: number
  /** Peak amplitude; 9000 is normal speech, 900 a soft word. */
  amp?: number
  /** Seconds the word lasts. */
  sec?: number
}

/** Words 0.35 s long with 0.12 s between them, over a quiet floor (optionally noisy). */
function build(parts: Part[], noise = 30): Int16Array {
  const chunks: number[] = []
  let seed = 7
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  const floor = (n: number): void => {
    for (let i = 0; i < n; i++) chunks.push(Math.round(rand() * noise))
  }
  for (const p of parts) {
    if (p.pause !== undefined) {
      floor(Math.round(p.pause * SAMPLE_RATE))
      continue
    }
    const n = Math.round((p.sec ?? 0.35) * SAMPLE_RATE)
    const hz = pitch(p.word!)
    for (let i = 0; i < n; i++)
      chunks.push(
        Math.round(
          Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * (p.amp ?? 9000) + rand() * noise
        )
      )
    floor(Math.round(0.12 * SAMPLE_RATE))
  }
  return Int16Array.from(chunks)
}

/** `n` words starting at word `from`, a pause after every `every` words. */
function talk(n: number, from = 0, every = 8, pause = 0.7): Part[] {
  const parts: Part[] = []
  for (let k = 0; k < n; k++) {
    parts.push({ word: (from + k) % (WORDS.length - 4) })
    if ((k + 1) % every === 0 && k + 1 < n) parts.push({ pause })
  }
  return parts
}

class FakeSettings extends EventEmitter {
  value: Settings = defaultSettings()
  constructor() {
    super()
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

/** Streams the clip in 100 ms chunks at `speed` times real time, then the key comes up. */
class FakeRecorder extends EventEmitter {
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
  async feed(speed: number): Promise<void> {
    while (this.fed < this.pcm.length) {
      this.fed = Math.min(this.pcm.length, this.fed + 1600)
      this.emit('chunk', this.id, this.fed, 0.5)
      await new Promise((r) => setTimeout(r, 100 / speed))
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
  formatter: async () => null
}

describe('the last word survives the stop', () => {
  let dir: string
  let history: HistoryStore
  let controller: DictationController
  let recorder: FakeRecorder
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-endings-'))
    const recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(dir, recordings)
    inject.calls.length = 0
    heard.requests = 0
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

  const dictate = async (
    parts: Part[],
    opts: { noise?: number; speed?: number } = {}
  ): Promise<{ text: string; said: string[] }> => {
    recorder.pcm = build(parts, opts.noise)
    controller.handle({ type: 'start', mode: 'hold' })
    await recorder.feed(opts.speed ?? 40)
    controller.handle({ type: 'stop' })
    for (let i = 0; i < 2000 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 5))
    const text = (history.list().entries[0]?.finalText ?? '').toLowerCase()
    return { text, said: text.match(/[a-z]+/g) ?? [] }
  }

  const LAST = WORDS.length - 1
  const cases: Array<[string, Part[], { noise?: number; speed?: number }?]> = [
    ['short, stopped on the last word', [...talk(5)]],
    ['short, stopped mid-word', [...talk(4), { word: LAST, sec: 0.2 }]],
    ['short, soft last word', [...talk(5), { word: LAST, amp: 900 }]],
    ['short, very soft last word', [...talk(5), { word: LAST, amp: 400 }]],
    ['short, a pause then one word', [...talk(5), { pause: 1.2 }, { word: LAST }]],
    ['short, a pause then one soft word', [...talk(5), { pause: 1.2 }, { word: LAST, amp: 900 }]],
    ['short, a brief last word', [...talk(5), { word: LAST, sec: 0.12 }]],
    ['short, in noise', [...talk(6)], { noise: 1500 }],
    ['short, in noise, soft last word', [...talk(6), { word: LAST, amp: 2500 }], { noise: 1500 }],
    ['long, stopped on the last word', [...talk(70)]],
    ['long, a pause then one soft word', [...talk(70), { pause: 1.2 }, { word: LAST, amp: 900 }]],
    ['long, a brief last word', [...talk(70), { word: LAST, sec: 0.12 }]],
    ['long, stopped mid-word', [...talk(70), { word: LAST, sec: 0.2 }]]
  ]

  for (const [name, parts, opts] of cases)
    it(
      name,
      async () => {
        // The words are there to hear in the whole recording (the fake model is not the limit)...
        const words = parts.filter((p) => p.word !== undefined).map((p) => WORDS[p.word!])
        expect(heard.decode(build(parts, opts?.noise))).toEqual(words)
        // ...and after the stop path, all of them reach the text.
        const { said } = await dictate(parts, opts)
        // Every word, in order, and the last one above all.
        expect(said.at(-1)).toBe(words.at(-1))
        expect(said).toEqual(words)
      },
      60_000
    )
})
