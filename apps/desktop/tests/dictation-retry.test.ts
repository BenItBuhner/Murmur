import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SttError, type TranscribeOutput } from '@core/stt'
import { defaultSettings, type Settings } from '@shared/settings'
import type { OverlayState } from '@shared/types'

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
  transcribe: async (): Promise<TranscribeOutput> => {
    provider.requests++
    if (provider.outcome === 'timeout')
      throw new SttError('The request timed out after 45000 ms', 'timeout')
    return {
      text: 'um so hello from murmur this is a test',
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

class FakeRecorder {
  pcm = speech(1.5)
  start = vi.fn()
  cancel = vi.fn()
  stop = vi.fn(async () => this.pcm)
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
    provider: 'openai-compatible',
    cfg: {
      kind: 'openai-compatible' as const,
      baseUrl: 'http://stt.test/v1',
      apiKey: '',
      model: 'whisper-1',
      language: 'auto',
      timeoutMs: 45000
    },
    fallbackModel: ''
  }),
  llm: async () => {
    throw new Error('no formatting model')
  },
  complete: async () => {
    throw new Error('no formatting model')
  },
  refreshedStt: async () => null
}

describe('DictationController retry', () => {
  let dir: string
  let history: HistoryStore
  let recordings: RecordingStore
  let states: OverlayState[]
  let controller: DictationController

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 400 && controller.isBusy; i++) await new Promise((r) => setTimeout(r, 5))
    expect(controller.isBusy).toBe(false)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-retry-'))
    recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(dir, recordings)
    states = []
    inject.calls.length = 0
    provider.requests = 0
    provider.outcome = 'timeout'
    controller = new DictationController({
      settings: new FakeSettings() as never,
      history,
      recorder: new FakeRecorder() as never,
      recordings,
      hook: hook as never,
      inference: inference as never,
      overlay: { setState: (s) => states.push(s), playSound: () => undefined },
      getActiveWindow: async () => ({ title: 'Notes', app: 'notes' })
    })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function dictateAndFail(): Promise<string> {
    controller.handle({ type: 'start', mode: 'hold' })
    controller.handle({ type: 'stop' })
    await settle()
    const failed = history.list().entries
    expect(failed).toHaveLength(1)
    return failed[0].id
  }

  it('keeps the audio of a timed-out dictation and offers a retry on the pill', async () => {
    const id = await dictateAndFail()
    const entry = history.get(id)!
    expect(entry.error).toBe('The server took too long to respond')
    expect(entry.finalText).toBe('')
    expect(entry.recording).toBe(`${id}.wav`)
    expect(recordings.has(entry.recording)).toBe(true)

    const error = states.find((s) => s.phase === 'error')
    expect(error).toMatchObject({ message: 'The server took too long to respond', retryId: id })
    expect(inject.calls).toHaveLength(0)
  })

  it('retry from the pill sends the stored audio again and types the text this time', async () => {
    const id = await dictateAndFail()
    const createdAt = history.get(id)!.createdAt
    const requestsSoFar = provider.requests
    provider.outcome = 'ok'

    const result = await controller.retry(id, { inject: true })

    expect(result).toEqual({ ok: true })
    expect(provider.requests).toBeGreaterThan(requestsSoFar)
    const entry = history.get(id)!
    expect(entry.finalText).toBe('So hello from murmur this is a test')
    expect(entry.error).toBeUndefined()
    expect(entry.attempts).toBe(2)
    expect(entry.createdAt).toBe(createdAt)
    expect(entry.recording).toBe(`${id}.wav`)
    expect(history.list().entries).toHaveLength(1)
    expect(inject.calls).toEqual([{ text: 'So hello from murmur this is a test ', method: 'auto' }])
    expect(states.at(-1)).toMatchObject({ phase: 'success' })
  })

  it('retry from History only copies the text, and a retry that fails again stays retryable', async () => {
    const id = await dictateAndFail()

    const again = await controller.retry(id, { inject: false })
    expect(again.ok).toBe(false)
    expect(history.get(id)).toMatchObject({
      attempts: 2,
      error: 'The server took too long to respond'
    })
    expect(states.at(-1)).toMatchObject({ phase: 'error', retryId: id })

    provider.outcome = 'ok'
    const result = await controller.retry(id, { inject: false })
    expect(result).toEqual({ ok: true })
    expect(inject.calls).toEqual([
      { text: 'So hello from murmur this is a test ', method: 'clipboard' }
    ])
    expect(history.get(id)).toMatchObject({
      attempts: 3,
      injected: false,
      injectionMethod: 'clipboard'
    })
    expect(states.at(-1)).toMatchObject({
      phase: 'success',
      message: 'Transcribed — copied to clipboard'
    })
  })

  it('refuses to retry what has no recording or already has its text', async () => {
    provider.outcome = 'ok'
    controller.handle({ type: 'start', mode: 'hold' })
    controller.handle({ type: 'stop' })
    await settle()
    const done = history.list().entries[0]
    expect(done.finalText).not.toBe('')
    expect(await controller.retry(done.id, { inject: true })).toMatchObject({ ok: false })
    expect(await controller.retry('nope', { inject: true })).toMatchObject({ ok: false })
  })

  it('does not keep the audio of a successful dictation when recordings are turned off', async () => {
    const settings = new FakeSettings()
    settings.value.audio.keepRecordings = false
    controller = new DictationController({
      settings: settings as never,
      history,
      recorder: new FakeRecorder() as never,
      recordings,
      hook: hook as never,
      inference: inference as never,
      overlay: { setState: (s) => states.push(s), playSound: () => undefined },
      getActiveWindow: async () => ({ title: '', app: '' })
    })
    // The failure keeps its audio regardless, so it can be sent again...
    const id = await dictateAndFail()
    expect(recordings.has(history.get(id)!.recording)).toBe(true)
    // ...and the audio goes once the dictation has its text.
    provider.outcome = 'ok'
    expect(await controller.retry(id, { inject: true })).toEqual({ ok: true })
    expect(history.get(id)!.recording).toBeUndefined()
    expect(recordings.info().count).toBe(0)
  })
})
