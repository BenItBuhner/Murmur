import { EventEmitter } from 'node:events'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TranscribeOutput } from '@core/stt'
import { decodeWavPcm16 } from '@core/audio/wav'
import { formatTranscript, joinSeam } from '@engine'
import { defaultSettings, type Settings } from '@shared/settings'
import { DictationController } from '../../src/main/dictation/session'
import { HistoryStore } from '../../src/main/store/history'
import { RecordingStore } from '../../src/main/store/recordings'
import { align, scoreSeams, tokens } from '../../../../packages/text-engine/eval/long'

/**
 * Real speech through the real dictation pipeline: spoken recordings (WAV, 16 kHz mono, with a
 * meta.json of what was said) are fed to the DictationController as the microphone would, and
 * every speech request goes to a local Whisper server (POST a WAV, get {text}). Formatting is the
 * rule-based formatter, so what is measured is speech, chunking, seams, silence and endings.
 *
 *   MURMUR_REAL_SPEECH=<dir with *.wav + meta.json> MURMUR_REAL_SPEECH_URL=http://127.0.0.1:8765 \
 *   npx vitest run tests/bench/real-speech.test.ts
 *
 * Writes <dir>/result-<MURMUR_REAL_SPEECH_TAG|run>.json.
 */

const DIR = process.env.MURMUR_REAL_SPEECH ?? ''
const URL_ = process.env.MURMUR_REAL_SPEECH_URL ?? 'http://127.0.0.1:8765'
const TAG = process.env.MURMUR_REAL_SPEECH_TAG ?? 'run'
const SAMPLE_RATE = 16000
// MURMUR_REAL_SPEECH_PROMPT=1: the speech prompt each request carries goes to the server (header
// x-prompt), for a server that honours it (tests/bench/real-speech/server.py with prompt support).
const SEND_PROMPT = process.env.MURMUR_REAL_SPEECH_PROMPT === '1'

// MURMUR_REAL_SPEECH_LOG=<file>: the session's log lines, to see which path each release took.
if (process.env.MURMUR_REAL_SPEECH_LOG) {
  const file = process.env.MURMUR_REAL_SPEECH_LOG
  for (const k of ['log', 'warn', 'error'] as const)
    console[k] = (...a: unknown[]) => appendFileSync(file, `${a.map(String).join(' ')}\n`)
}

const inject = vi.hoisted(() => ({
  injectText: vi.fn(async (_text: string, opts: { method: string }) => ({
    ok: true,
    method: opts.method === 'clipboard' ? 'clipboard' : 'paste',
    ms: 1
  })),
  readSelection: vi.fn(async () => ({ text: '', restore: () => undefined }))
}))
vi.mock('../../src/main/inject', () => ({
  injectText: inject.injectText,
  readSelection: inject.readSelection
}))

const calls = vi.hoisted(() => ({ n: 0, inFlight: 0 }))

async function whisper(wav: Uint8Array, prompt?: string): Promise<string> {
  calls.n++
  calls.inFlight++
  try {
    const headers: Record<string, string> =
      SEND_PROMPT && prompt ? { 'x-prompt': encodeURIComponent(prompt) } : {}
    const res = await fetch(URL_, { method: 'POST', body: wav as BodyInit, headers })
    const json = (await res.json()) as { text: string }
    if (process.env.MURMUR_REAL_SPEECH_CLIPS)
      writeFileSync(`${process.env.MURMUR_REAL_SPEECH_CLIPS}/${calls.n}.wav`, wav)
    if (process.env.MURMUR_REAL_SPEECH_CLIPS)
      writeFileSync(`${process.env.MURMUR_REAL_SPEECH_CLIPS}/${calls.n}.txt`, json.text)
    return json.text.trim()
  } finally {
    calls.inFlight--
  }
}

vi.mock('@core/stt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/stt')>()
  return {
    ...actual,
    getSttProvider: () => ({
      transcribe: async (input: {
        wav: Uint8Array
        prompt?: string
      }): Promise<TranscribeOutput> => ({
        text: await whisper(input.wav, input.prompt),
        language: 'en',
        durationSec: (input.wav.length - 44) / 2 / SAMPLE_RATE,
        latencyMs: 1
      }),
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' })
    })
  }
})

// The gateway's one-call release: speech, the prefix seam-joined on, then formatting.
vi.mock('@core/stt/openai-compatible', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/stt/openai-compatible')>()
  return {
    ...actual,
    prewarmGateway: async () => undefined,
    dictateRelease: async (
      input: { wav: Uint8Array; prompt?: string },
      _cfg: unknown,
      prefix?: string,
      format?: { context?: unknown }
    ) => {
      const raw = await whisper(input.wav, input.prompt)
      const transcript = prefix?.trim() ? joinSeam(prefix.trim(), raw).text : raw
      const f =
        format && transcript
          ? await formatTranscript(
              { transcript, mode: 'smart', context: format.context as never },
              null
            )
          : null
      return {
        stt: {
          text: raw,
          language: 'en',
          durationSec: (input.wav.length - 44) / 2 / SAMPLE_RATE,
          latencyMs: 1
        },
        transcript,
        format: f,
        rules: true
      }
    }
  }
})

const formatter = {
  source: 'murmur',
  format: async (input: { transcript: string; context: unknown }) =>
    formatTranscript(
      { transcript: input.transcript, mode: 'smart', context: input.context as never },
      null
    ),
  layout: async (text: string) => ({ text, outcome: 'skipped', detail: 'eval', llmMs: 0 })
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

/** The microphone, fed at the speed the pieces come back (so tail speculation sees real gaps). */
class FakeRecorder extends EventEmitter {
  fed = 0
  id = ''
  constructor(readonly pcm: Int16Array) {
    super()
  }
  start = (id: string): void => {
    this.id = id
  }
  cancel = (): void => undefined
  stop = async (): Promise<Int16Array> => this.pcm.subarray(0, this.fed)
  read(_id: string, from: number): Int16Array {
    return this.pcm.slice(from, this.fed)
  }
  async feed(): Promise<void> {
    while (this.fed < this.pcm.length) {
      this.fed = Math.min(this.pcm.length, this.fed + 1600)
      this.emit('chunk', this.id, this.fed, 0.5)
      // Let background work run between chunks, as it would while the user keeps talking.
      if (this.fed % (SAMPLE_RATE * 5) < 1600) await settleBackground()
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function settleBackground(): Promise<void> {
  let quiet = 0
  for (let i = 0; i < 100000 && quiet < 10; i++) {
    await sleep(5)
    quiet = calls.inFlight ? 0 : quiet + 1
  }
}

const hook = {
  waitForKeysUp: async () => true,
  beginSynthetic: () => undefined,
  endSynthetic: () => undefined,
  notifySessionStarted: () => undefined,
  notifySessionEnded: () => undefined
}

interface Meta {
  id: string
  text: string
  ending: string
  sec: number
}

/** How the transcript ends against what was said. */
function endingScore(ref: string, hyp: string): { lostAtEnd: number; addedAtEnd: string } {
  const r = tokens(ref)
  const h = tokens(hyp)
  const { map } = align(r, h)
  const matched = new Set(map.filter((i) => i >= 0))
  let lostAtEnd = 0
  for (let i = r.length - 1; i >= Math.max(0, r.length - 8); i--) if (!matched.has(i)) lostAtEnd++
  let lastMatched = -1
  for (let j = h.length - 1; j >= 0; j--)
    if (map[j] >= 0) {
      lastMatched = j
      break
    }
  return {
    lostAtEnd,
    addedAtEnd: h
      .slice(lastMatched + 1)
      .map((t) => t.raw)
      .join(' ')
  }
}

describe.skipIf(!DIR)('real speech through the dictation pipeline', () => {
  it(
    'transcribes every recording',
    async () => {
      const metas = JSON.parse(readFileSync(join(DIR, 'meta.json'), 'utf8')) as Meta[]
      const only = process.env.MURMUR_REAL_SPEECH_ONLY
      const rows = []
      for (const m of metas) {
        if (only && !m.id.includes(only)) continue
        const pcm = decodeWavPcm16(new Uint8Array(readFileSync(join(DIR, `${m.id}.wav`)))).pcm
        const dir = mkdtempSync(join(tmpdir(), 'murmur-real-'))
        try {
          const recordings = new RecordingStore(join(dir, 'recordings'))
          const history = new HistoryStore(dir, recordings)
          const recorder = new FakeRecorder(pcm)
          const controller = new DictationController({
            settings: new FakeSettings() as never,
            history,
            recorder: recorder as never,
            recordings,
            hook: hook as never,
            inference: inference as never,
            overlay: { setState: () => undefined, playSound: () => undefined },
            getActiveWindow: async () => ({ title: 'Notes', app: 'notes' })
          })
          const before = calls.n
          controller.handle({ type: 'start', mode: 'hold' })
          await recorder.feed()
          await settleBackground()
          controller.handle({ type: 'stop' })
          for (let i = 0; i < 120000 && controller.isBusy; i++) await sleep(5)
          const entry = history.list().entries[0]
          const text = entry?.finalText ?? ''
          const seams = scoreSeams(m.text, text)
          rows.push({
            id: m.id,
            ending: m.ending,
            sec: m.sec,
            requests: calls.n - before,
            wer: +(100 * seams.wer).toFixed(1),
            falseBreaks: seams.falseBreaks,
            missedBreaks: seams.missedBreaks,
            falseCaps: seams.falseCaps,
            ...endingScore(m.text, text),
            error: entry?.error,
            raw: entry?.rawText,
            text
          })
          writeFileSync(join(DIR, `result-${TAG}.json`), JSON.stringify(rows, null, 2))
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
      expect(rows.length).toBeGreaterThan(0)
    },
    4 * 3600_000
  )
})
