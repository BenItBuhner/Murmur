import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorFromResponse, type TranscribeOutput } from '@core/stt'
import { formatTranscript, type FormatInput } from '@engine'
import { describeServiceNotice, parseServiceNotice } from '@shared/inference'
import { defaultSettings, type Settings } from '@shared/settings'
import type { OverlayState } from '@shared/types'
import type { FormatOutcome } from '../src/main/inference/router'

// The session talks to the desktop through the injector and to the world through the speech
// provider and the formatter; all three are replaced, everything else is the real code.
const inject = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; method: string }>,
  injectText: vi.fn(async (text: string, opts: { method: string }) => {
    inject.calls.push({ text, method: opts.method })
    return { ok: true, method: 'paste', ms: 1 }
  }),
  readSelection: vi.fn(async () => ({ text: '', restore: () => undefined }))
}))
vi.mock('../src/main/inject', () => ({
  injectText: inject.injectText,
  readSelection: inject.readSelection
}))

/** What the gateway answers (HTTP 503) when the speech provider behind it is not answering. */
const SPEECH_DOWN = JSON.stringify({
  error: {
    type: 'murmur_gateway_error',
    code: 'provider_unavailable',
    message: "Murmur's speech service is unavailable right now",
    service: 'speech',
    reason: 'timeout',
    retryAfterSec: 15
  }
})
/** The same for the formatting model, from a route that cannot degrade. */
const FORMATTING_DOWN = JSON.stringify({
  error: {
    type: 'murmur_gateway_error',
    code: 'provider_unavailable',
    message: "Murmur's formatting service is unavailable right now",
    service: 'formatting',
    reason: 'unavailable',
    retryAfterSec: 9
  }
})

const provider = vi.hoisted(() => ({
  requests: 0,
  /** The next transcription requests: refused, or answered. */
  refusal: null as string | null,
  refusalStatus: 503,
  transcribe: async (): Promise<TranscribeOutput> => {
    provider.requests++
    if (provider.refusal) throw errorFromResponse(provider.refusalStatus, provider.refusal)
    return { text: 'hello from murmur', language: 'en', durationSec: 1.2, latencyMs: 10 }
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

import { DictationController, friendlyError, serviceNoticeOf } from '../src/main/dictation/session'
import { HistoryStore } from '../src/main/store/history'
import { RecordingStore } from '../src/main/store/recordings'

const SAMPLE_RATE = 16000

function speech(seconds: number): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SAMPLE_RATE
    const amplitude = t % 0.5 < 0.35 ? 11000 : 60
    pcm[i] = Math.round(Math.sin(i / 17) * amplitude + (Math.random() - 0.5) * 40)
  }
  return pcm
}

class FakeSettings extends EventEmitter {
  value: Settings = defaultSettings()
  constructor(mode: Settings['formatting']['mode']) {
    super()
    this.value.formatting.mode = mode
  }
  get(): Settings {
    return this.value
  }
  patch(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch }
    return this.value
  }
}

const hook = {
  waitForKeysUp: async () => true,
  beginSynthetic: () => undefined,
  endSynthetic: () => undefined,
  notifySessionStarted: () => undefined,
  notifySessionEnded: () => undefined
}

const GATEWAY = 'https://happy-otter-123.convex.site/v1'
const formatter = vi.hoisted(() => ({
  /** What the gateway's /v1/format does: answer with the model, degrade, or refuse outright. */
  behaviour: 'model' as 'model' | 'degraded' | 'refuse',
  calls: 0
}))
const inference = {
  stt: async () => ({
    source: 'murmur',
    provider: 'murmur',
    cfg: {
      kind: 'openai-compatible' as const,
      baseUrl: GATEWAY,
      apiKey: 'jwt',
      model: 'murmur-transcribe',
      language: 'auto',
      timeoutMs: 45000
    },
    fallbackModel: ''
  }),
  llm: async () => ({
    source: 'murmur',
    cfg: { baseUrl: GATEWAY, apiKey: 'jwt', model: 'murmur-format', timeoutMs: 8000 }
  }),
  formatter: async () => ({
    source: 'murmur',
    format: async (input: FormatInput): Promise<FormatOutcome> => {
      formatter.calls++
      if (formatter.behaviour === 'refuse') throw errorFromResponse(503, FORMATTING_DOWN)
      if (formatter.behaviour === 'model') {
        return formatTranscript(input, async () => ({ text: 'Hello from Murmur.' }))
      }
      // The gateway's own degradation: rule-based text, the calm sentence as the reason.
      const result = await formatTranscript(input, null)
      return {
        ...result,
        status: {
          outcome: 'failed',
          detail: "Murmur's formatting service is unavailable right now",
          attempts: 1
        }
      }
    }
  }),
  complete: async () => {
    throw new Error('not used')
  },
  refreshedStt: async () => null
}

describe('DictationController when Murmur’s provider is down', () => {
  let dir: string
  let history: HistoryStore
  let recordings: RecordingStore
  let states: OverlayState[]
  let controller: DictationController

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 400 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 5))
    expect(controller.isBusy).toBe(false)
  }

  function build(mode: Settings['formatting']['mode']): void {
    controller = new DictationController({
      settings: new FakeSettings(mode) as never,
      history,
      recorder: {
        pcm: speech(1.5),
        on: vi.fn(),
        start: vi.fn(),
        cancel: vi.fn(),
        stop: vi.fn(async () => speech(1.5))
      } as never,
      recordings,
      hook: hook as never,
      inference: inference as never,
      overlay: { setState: (s) => states.push(s), playSound: () => undefined },
      getActiveWindow: async () => ({ title: 'Notes', app: 'notes' })
    })
  }

  async function dictate(): Promise<void> {
    controller.handle({ type: 'start', mode: 'hold' })
    controller.handle({ type: 'stop' })
    await settle()
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-unavailable-'))
    recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(dir, recordings)
    states = []
    inject.calls.length = 0
    provider.requests = 0
    provider.refusal = null
    provider.refusalStatus = 503
    formatter.behaviour = 'model'
    formatter.calls = 0
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('the speech service being down keeps the recording and puts the calm notice on the pill, with Retry', async () => {
    build('smart')
    provider.refusal = SPEECH_DOWN
    await dictate()

    const [entry] = history.list().entries
    expect(entry.finalText).toBe('')
    expect(entry.error).toBe("Murmur's speech service is unavailable right now")
    expect(entry.recording).toBe(`${entry.id}.wav`)
    expect(recordings.has(entry.recording)).toBe(true)
    expect(inject.calls).toHaveLength(0)
    expect(formatter.calls).toBe(0)
    // One request: the gateway already said the provider is down, nothing to wait for.
    expect(provider.requests).toBe(1)

    const shown = states.find((s) => s.phase === 'error')!
    expect(shown.retryId).toBe(entry.id)
    expect(shown.message).toBe(entry.error)
    expect(shown.limit).toBeUndefined()
    expect(shown.service).toEqual({
      service: 'speech',
      reason: 'timeout',
      retryAfterSec: 15,
      message: "Murmur's speech service is unavailable right now"
    })
    expect(describeServiceNotice(shown.service!)).toEqual({
      title: "Murmur's speech service is unavailable right now",
      detail: 'Not your connection or your mic. Your recording is kept — try again in a moment.'
    })

    // Once the provider is back, the same recording goes through from the pill.
    provider.refusal = null
    const result = await controller.retry(entry.id, { inject: true })
    expect(result).toEqual({ ok: true })
    expect(history.get(entry.id)).toMatchObject({
      finalText: 'Hello from Murmur.',
      attempts: 2,
      error: undefined
    })
    expect(inject.calls).toEqual([{ text: 'Hello from Murmur. ', method: 'auto' }])
    expect(states.at(-1)).toMatchObject({ phase: 'success' })
    expect(states.at(-1)?.service).toBeUndefined()
  })

  it('a formatting service that is down never drops the text: the gateway’s rule-based text goes in and History says why', async () => {
    build('smart')
    formatter.behaviour = 'degraded'
    await dictate()

    expect(inject.calls).toEqual([{ text: 'Hello from murmur ', method: 'auto' }])
    const [entry] = history.list().entries
    expect(entry.finalText).toBe('Hello from murmur')
    expect(entry.error).toBeUndefined()
    expect(entry.llmUsed).toBe(false)
    expect(entry.llm).toMatchObject({
      outcome: 'failed',
      detail: "Murmur's formatting service is unavailable right now"
    })
    expect(states.at(-1)!.phase).toBe('success')
    expect(states.some((s) => s.phase === 'error')).toBe(false)
  })

  it('a formatting route refused outright falls back to the local rule-based text with the same reason', async () => {
    build('smart')
    formatter.behaviour = 'refuse'
    await dictate()

    expect(inject.calls).toEqual([{ text: 'Hello from murmur ', method: 'auto' }])
    const [entry] = history.list().entries
    expect(entry.llm).toMatchObject({
      outcome: 'failed',
      detail: "Murmur's formatting service is unavailable right now"
    })
    expect(states.at(-1)!.phase).toBe('success')
    expect(states.at(-1)!.service).toBeUndefined()
  })

  it('reads the notice off a gateway answer and shows its sentence verbatim, and off nothing else', () => {
    const err = errorFromResponse(503, SPEECH_DOWN)
    expect(err.code).toBe('provider_unavailable')
    expect(err.kind).toBe('server')
    expect(err.status).toBe(503)
    expect(err.limit).toBeUndefined()
    expect(err.service).toMatchObject({ service: 'speech', reason: 'timeout', retryAfterSec: 15 })
    expect(friendlyError(err)).toBe("Murmur's speech service is unavailable right now")
    expect(serviceNoticeOf(err)).toBe(err.service)

    const formatting = errorFromResponse(503, FORMATTING_DOWN)
    expect(formatting.service).toMatchObject({ service: 'formatting', retryAfterSec: 9 })
    expect(describeServiceNotice(formatting.service!).detail).toBe(
      'Not your connection. Nothing was changed — try again in a moment.'
    )

    // Another 503 (a busy provider, a plain outage) is not a service notice.
    const busy = errorFromResponse(
      503,
      JSON.stringify({
        error: {
          code: 'upstream_busy',
          message: 'The model provider is busy; try again in a moment'
        }
      })
    )
    expect(busy.service).toBeUndefined()
    expect(serviceNoticeOf(errorFromResponse(503, 'Service Unavailable'))).toBeUndefined()
    expect(serviceNoticeOf(new Error('nope'))).toBeUndefined()

    // An instance that sends the code without the fields still gets a notice for the right model.
    expect(
      parseServiceNotice({ code: 'provider_unavailable', message: 'down' }, undefined, 'formatting')
    ).toEqual({ service: 'formatting', reason: 'unknown', retryAfterSec: null, message: 'down' })
    expect(
      parseServiceNotice({ code: 'provider_unavailable', retryAfterSec: 2.2 }, 'x')?.retryAfterSec
    ).toBe(3)
    expect(parseServiceNotice({ code: 'quota_exceeded' }, 'x')).toBeNull()
    expect(parseServiceNotice(null, 'x')).toBeNull()
  })
})
