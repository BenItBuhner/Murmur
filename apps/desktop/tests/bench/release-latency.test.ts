import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SttError, type TranscribeOutput } from '@core/stt'
import { defaultSettings, type Settings } from '@shared/settings'
import { DictationController } from '../../src/main/dictation/session'
import { HistoryStore } from '../../src/main/store/history'
import { RecordingStore } from '../../src/main/store/recordings'

/**
 * How long the release of a long dictation takes, through the real DictationController: the real
 * chunking, background pieces, release recovery, joins and layout. Only the network is simulated.
 *
 *   MURMUR_BENCH=1 [MURMUR_BENCH_MINUTES=25] [MURMUR_BENCH_TRIALS=5] npx vitest run tests/bench
 *
 * The recording is fed at once and the background work is let finish fast (it happens while the
 * user speaks, so it is not release time). From the key-up on, every model call takes a realistic
 * time: speech 300 ms + 25 ms per second of audio, formatting 300 ms + 5 ms per word, layout
 * 800 ms + 0.2 ms per word, each times a log-normal factor (sigma 0.3). The defaults are close to
 * gpt-oss-20b and Whisper large-v3-turbo on Groq; MURMUR_BENCH_SPEED scales all of them.
 *
 * Writes bench-results/release-latency.json and prints a table. Run the same file against an
 * older checkout to compare.
 */

const enabled = !!process.env.MURMUR_BENCH
const MINUTES = Number(process.env.MURMUR_BENCH_MINUTES ?? '25')
const TRIALS = Number(process.env.MURMUR_BENCH_TRIALS ?? '5')
const SPEED = Number(process.env.MURMUR_BENCH_SPEED ?? '1')
/** Tail speculation, as the app runs by default; MURMUR_BENCH_SPEC=0 turns it off. */
const SPEC = process.env.MURMUR_BENCH_SPEC !== '0'
const SAMPLE_RATE = 16000

const inject = vi.hoisted(() => ({
  injectedAt: 0,
  injectText: vi.fn(async (_text: string, opts: { method: string }) => {
    inject.injectedAt = Date.now()
    return { ok: true, method: opts.method === 'clipboard' ? 'clipboard' : 'paste', ms: 1 }
  }),
  readSelection: vi.fn(async () => ({ text: '', restore: () => undefined }))
}))
vi.mock('../../src/main/inject', () => ({
  injectText: inject.injectText,
  readSelection: inject.readSelection
}))

/** The simulated network. `released`: the key is up, so calls take realistic time. */
const net = vi.hoisted(() => {
  let seed = 1
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
  return {
    reseed: (s: number) => {
      seed = s
    },
    rand,
    noise: (): number => Math.exp(0.3 * gauss()),
    released: false,
    releasedAt: 0,
    speed: 1,
    sttCalls: 0,
    formatCalls: 0,
    releaseSttCalls: 0,
    releaseFormatCalls: 0,
    releaseFormatWords: 0,
    inFlight: 0,
    /** Background speech requests (1-based) whose audio fails every time until the key-up. */
    failStt: new Set<number>(),
    failSig: new Set<string>(),
    /** Background format calls (1-based) that fail. */
    failFormat: new Set<number>(),
    /** Background format calls (1-based) still out at the key-up; they answer this long after it. */
    slowFormat: new Map<number, number>(),
    /** Layout requests made after the key-up never answer. */
    hangLayout: false,
    sentence: 0
  }
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A sentence of 8 to 16 made-up words, numbered so a lost or doubled one shows. */
function sentence(): string {
  const n = 8 + Math.floor(net.rand() * 9)
  const body = Array.from({ length: n - 1 }, () => `w${Math.floor(net.rand() * 1e6).toString(36)}`)
  return `${body.join(' ')} s${++net.sentence}.`
}

const words = (t: string): number => t.split(/\s+/).filter(Boolean).length

vi.mock('@core/stt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/stt')>()
  return {
    ...actual,
    getSttProvider: () => ({
      transcribe: async (input: { wav: Uint8Array }): Promise<TranscribeOutput> => {
        const n = ++net.sttCalls
        const seconds = (input.wav.length - 44) / 2 / SAMPLE_RATE
        const release = net.released
        net.inFlight++
        try {
          if (release) {
            net.releaseSttCalls++
            await sleep(((300 + 25 * seconds) * net.noise()) / net.speed)
          } else await sleep(2)
          // The failing request's audio fails every time while recording, retries included.
          const sig = `${input.wav.length}:${input.wav.slice(44, 4044).reduce((a, b) => (a * 31 + b) | 0, 0)}`
          if (!release && net.failStt.has(n)) net.failSig.add(sig)
          if (!release && net.failSig.has(sig)) throw new SttError('upstream 503', 'server')
          // ~150 words a minute of speech.
          const target = Math.max(1, Math.round((seconds / 60) * 150))
          const parts: string[] = []
          while (words(parts.join(' ')) < target) parts.push(sentence())
          return { text: parts.join(' '), language: 'en', durationSec: seconds, latencyMs: 1 }
        } finally {
          net.inFlight--
        }
      },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' })
    })
  }
})

class FakeSettings extends EventEmitter {
  value: Settings = defaultSettings()
  constructor() {
    super()
    this.value.stt.source = 'custom'
    this.value.stt.baseUrl = 'http://stt.test/v1'
    this.value.stt.model = 'whisper-1'
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

/** Speech with a pause of 0.8 s at a random point every 5 to 12 s, like someone talking. */
function talk(seconds: number): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SAMPLE_RATE
    const voiced = t % 0.5 < 0.35
    pcm[i] = Math.round(Math.sin(i / 17) * (voiced ? 11000 : 60) + (net.rand() - 0.5) * 40)
  }
  for (let s = 5 + net.rand() * 7; s < seconds - 1; s += 5 + net.rand() * 7)
    pcm.fill(0, Math.round(s * SAMPLE_RATE), Math.round((s + 0.8) * SAMPLE_RATE))
  return pcm
}

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
  // Like the app's recorder: the samples are handed over without a copy.
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

const hook = {
  waitForKeysUp: async () => true,
  beginSynthetic: () => undefined,
  endSynthetic: () => undefined,
  notifySessionStarted: () => undefined,
  notifySessionEnded: () => undefined
}

// The one-call release on Murmur's gateway: speech of the audio after the speculation, then
// formatting of the speculation's last sentence + that text, on the edge.
vi.mock('@core/stt/openai-compatible', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/stt/openai-compatible')>()
  return {
    ...actual,
    prewarmGateway: async () => undefined,
    dictateRelease: async (input: { wav: Uint8Array }, _cfg: unknown, prefix?: string) => {
      const seconds = (input.wav.length - 44) / 2 / SAMPLE_RATE
      net.releaseSttCalls++
      const target = Math.max(1, Math.round((seconds / 60) * 150))
      const parts: string[] = []
      while (words(parts.join(' ')) < target) parts.push(sentence())
      const text = parts.join(' ')
      const transcript = `${prefix ?? ''} ${text}`.trim()
      net.releaseFormatCalls++
      net.releaseFormatWords += words(transcript)
      await sleep(((600 + 25 * seconds + 5 * words(transcript)) * net.noise()) / net.speed)
      return {
        stt: { text, language: 'en', durationSec: seconds, latencyMs: 1 },
        transcript,
        format: {
          text: transcript.charAt(0).toUpperCase() + transcript.slice(1),
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

interface FormatIn {
  transcript: string
}

const formatter = {
  source: 'murmur',
  format: async (input: FormatIn) => {
    const n = ++net.formatCalls
    const release = net.released
    net.inFlight++
    try {
      const w = words(input.transcript)
      if (release) {
        net.releaseFormatCalls++
        net.releaseFormatWords += w
        await sleep(((300 + 5 * w) * net.noise()) / net.speed)
      } else {
        const slow = net.slowFormat.get(n)
        if (slow !== undefined) {
          while (!net.released) await sleep(5)
          await sleep(Math.max(0, net.releasedAt + slow - Date.now()))
        } else await sleep(2)
        if (net.failFormat.has(n)) throw new Error('upstream 503')
      }
      return {
        text: input.transcript.charAt(0).toUpperCase() + input.transcript.slice(1),
        pressEnter: false,
        llmMs: 1,
        status: { outcome: 'used', attempts: 1 },
        stages: ['llm']
      }
    } finally {
      net.inFlight--
    }
  },
  layout: async (text: string) => {
    if (!net.released) {
      // Laid out while the user speaks, like the pieces' formatting.
      net.inFlight++
      try {
        await sleep(2)
      } finally {
        net.inFlight--
      }
    } else if (net.hangLayout) await new Promise(() => undefined)
    else await sleep(((800 + 0.2 * words(text)) * net.noise()) / net.speed)
    return { text, outcome: 'used', llmMs: 1 }
  }
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
      model: 'whisper-1',
      language: 'auto',
      timeoutMs: 45000,
      speed: 'normal' as const
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

interface Condition {
  name: string
  /** Arms the failures for a dictation whose background calls are about to start. */
  arm: (pieces: number) => void
}

/** About this many pieces per minute (measured on this audio; the cut after 18 s waits for a pause). */
const PIECES_PER_MIN = 2.6

const conditions: Condition[] = [
  { name: 'no failures', arm: () => undefined },
  {
    name: "one piece's formatting failed",
    arm: (n) => net.failFormat.add(1 + Math.floor(net.rand() * n))
  },
  {
    name: "one piece's formatting still out (answers 6 s after key-up)",
    arm: (n) => net.slowFormat.set(1 + Math.floor(net.rand() * n * 0.8), 6000)
  },
  {
    name: "one piece's speech failed twice",
    arm: (n) => net.failStt.add(1 + Math.floor(net.rand() * n * 0.8))
  },
  {
    name: '2% of background formats fail',
    arm: (n) => {
      for (let i = 1; i <= n * 2; i++) if (net.rand() < 0.02) net.failFormat.add(i)
    }
  }
]

interface Trial {
  condition: string
  seed: number
  releaseMs: number
  releaseSttCalls: number
  releaseFormatCalls: number
  releaseFormatWords: number
  stages: string[]
  words: number
  /** Calls made while the user spoke. */
  background: { stt: number; format: number }
  error?: string
}

const results: Trial[] = []

async function runTrial(
  condition: Condition,
  seed: number,
  minutes = MINUTES,
  speed = SPEED
): Promise<Trial> {
  net.reseed(seed)
  Object.assign(net, {
    released: false,
    releasedAt: 0,
    speed,
    hangLayout: false,
    sttCalls: 0,
    formatCalls: 0,
    releaseSttCalls: 0,
    releaseFormatCalls: 0,
    releaseFormatWords: 0,
    inFlight: 0,
    sentence: 0
  })
  net.failStt.clear()
  net.failSig.clear()
  net.failFormat.clear()
  net.slowFormat.clear()
  const dir = mkdtempSync(join(tmpdir(), 'murmur-bench-'))
  try {
    const recordings = new RecordingStore(join(dir, 'recordings'))
    const history = new HistoryStore(dir, recordings)
    const recorder = new FakeRecorder(talk(minutes * 60))
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
    condition.arm(Math.round(minutes * PIECES_PER_MIN))
    controller.handle({ type: 'start', mode: 'hold' })
    recorder.feedAll()
    // Let the background work finish (it would have, while the user spoke), all but a slow call.
    let quiet = 0
    for (let i = 0; i < 6000 && quiet < 40; i++) {
      await sleep(5)
      quiet = net.inFlight > net.slowFormat.size ? 0 : quiet + 1
    }
    const background = { stt: net.sttCalls, format: net.formatCalls }
    const { Session } = await import('node:inspector/promises')
    const prof = process.env.MURMUR_BENCH_PROFILE ? new Session() : null
    if (prof) {
      prof.connect()
      await prof.post('Profiler.enable')
      await prof.post('Profiler.start')
    }
    net.released = true
    net.releasedAt = Date.now()
    controller.handle({ type: 'stop' })
    inject.injectedAt = 0
    for (let i = 0; i < 24000 && controller.isBusy; i++) await sleep(5)
    // Key-up to the text landing in the field: what the user waits for.
    const releaseMs = (inject.injectedAt || Date.now()) - net.releasedAt
    if (prof) {
      const { profile } = await prof.post('Profiler.stop')
      writeFileSync(
        `${process.env.MURMUR_BENCH_PROFILE}-${seed}.cpuprofile`,
        JSON.stringify(profile)
      )
      prof.disconnect()
    }
    const entry = history.list().entries[0]
    if (process.env.MURMUR_BENCH_DEBUG)
      writeFileSync(process.env.MURMUR_BENCH_DEBUG, `${condition.name}\n${entry?.finalText}\n`, {
        flag: 'a'
      })
    return {
      condition: condition.name,
      seed,
      releaseMs,
      releaseSttCalls: net.releaseSttCalls,
      releaseFormatCalls: net.releaseFormatCalls,
      releaseFormatWords: net.releaseFormatWords,
      stages: entry?.stages ?? [],
      words: words(entry?.finalText ?? ''),
      background,
      error: entry?.error
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

/**
 * Runs in CI: with the network made instant, what is left of the release is Murmur's own work
 * (joins, silence scan, saving, finishing), which must stay well under a second however long the
 * dictation. The budgets are several times what a laptop measures, for slower CI machines.
 */
describe.skipIf(enabled)('release time spent outside the network', () => {
  const quick: Condition = { name: 'no failures', arm: () => undefined }
  for (const [label, minutes, budgetMs] of [
    ['a 10-second dictation', 10 / 60, 250],
    ['a 3-minute dictation', 3, 400],
    ['a 25-minute dictation', 25, 900]
  ] as const)
    it(`${label} is in the field within ${budgetMs} ms of the key-up`, async () => {
      const trial = await runTrial(quick, 1000, minutes, 1000)
      expect(trial.error).toBeUndefined()
      expect(trial.words).toBeGreaterThan(0)
      expect(trial.releaseMs).toBeLessThan(budgetMs)
    }, 60_000)

  it('a layout still out at the key-up never holds the text back', async () => {
    const hang: Condition = { name: 'layout hangs', arm: () => (net.hangLayout = true) }
    const trial = await runTrial(hang, 1000, 5, 1000)
    expect(trial.error).toBeUndefined()
    expect(trial.releaseMs).toBeLessThan(400)
    // The pieces were laid out while recording; that answer is used.
    expect(trial.stages).toContain('layout')
  }, 60_000)
})

describe.skipIf(!enabled)(`release latency of a ${MINUTES}-minute dictation`, () => {
  if (!SPEC) vi.stubEnv('MURMUR_TAIL_SPECULATION', '0')
  for (const c of conditions)
    it(
      c.name,
      async () => {
        for (let t = 0; t < TRIALS; t++) {
          const trial = await runTrial(c, 1000 + t * 7919)
          results.push(trial)
          expect(trial.error).toBeUndefined()
        }
      },
      TRIALS * 120_000
    )

  afterAll(() => {
    const rows = conditions.map((c) => {
      const ts = results.filter((r) => r.condition === c.name)
      const ms = ts.map((r) => r.releaseMs)
      return {
        condition: c.name,
        trials: ts.length,
        p50Ms: pct(ms, 0.5),
        maxMs: Math.max(...ms),
        releaseFormatWords: Math.round(
          ts.reduce((a, r) => a + r.releaseFormatWords, 0) / ts.length
        ),
        releaseSttCalls: Math.round(ts.reduce((a, r) => a + r.releaseSttCalls, 0) / ts.length)
      }
    })
    console.log(
      `\nRelease of a ${MINUTES}-minute dictation (${TRIALS} trials each, speed x${SPEED})`
    )
    console.table(rows)
    const out = resolve(__dirname, '../../bench-results')
    mkdirSync(out, { recursive: true })
    writeFileSync(
      join(out, 'release-latency.json'),
      JSON.stringify({ minutes: MINUTES, trials: TRIALS, speed: SPEED, rows, results }, null, 2)
    )
  })
})
