import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SttError, type TranscribeOutput } from '@core/stt'
import { decodeWavPcm16, encodeWavPcm16 } from '@core/audio/wav'
import { defaultSettings, type Settings } from '@shared/settings'
import type { HistoryEntry, OverlayState } from '@shared/types'

/**
 * A dictation fed by MURMUR_TEST_AUDIO_FILE, end to end: the real Recorder (with the clip on
 * disk standing in for the microphone), the real session controller, VAD, the speech request,
 * formatting, insertion, press-enter and Retry. The desktop is replaced at its two edges only:
 * the injector (Electron's clipboard and key synthesis) and the speech provider (HTTP).
 */

const inject = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; method: string; pressEnter: boolean }>,
  injectText: vi.fn(async (text: string, opts: { method: string; pressEnter?: boolean }) => {
    inject.calls.push({ text, method: opts.method, pressEnter: !!opts.pressEnter })
    return { ok: true, method: opts.method === 'clipboard' ? 'clipboard' : 'paste', ms: 1 }
  }),
  readSelection: vi.fn(async () => ({ text: '', restore: () => undefined }))
}))
vi.mock('../src/main/inject', () => ({
  injectText: inject.injectText,
  readSelection: inject.readSelection
}))

const provider = vi.hoisted(() => ({
  /** The WAV bytes of every transcription request, in order. */
  wavs: [] as Uint8Array[],
  outcome: 'ok' as 'ok' | 'timeout',
  text: 'um so hello from murmur this is a test',
  transcribe: async (req: { wav: Uint8Array }): Promise<TranscribeOutput> => {
    provider.wavs.push(req.wav)
    if (provider.outcome === 'timeout')
      throw new SttError('The request timed out after 45000 ms', 'timeout')
    return {
      text: provider.text,
      language: 'en',
      durationSec: req.wav.byteLength / 2 / 16000,
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

// The Recorder registers its IPC handlers on construction; outside Electron there is no ipcMain.
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))

import { Recorder } from '../src/main/audio/recorder'
import { resolveTestAudio, TEST_AUDIO_FILE } from '../src/main/audio/test-audio'
import { DictationController } from '../src/main/dictation/session'
import { HistoryStore } from '../src/main/store/history'
import { RecordingStore } from '../src/main/store/recordings'

const SAMPLE_RATE = 16000

/**
 * Speech-shaped audio: loud bursts over a quiet floor, so the adaptive VAD finds both — with a
 * pause every 200 ms, so that even the first 300 ms of a held clip carry a measurable floor.
 */
function speech(seconds: number): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SAMPLE_RATE
    const voiced = t % 0.2 < 0.12
    const amplitude = voiced ? 11000 : 60
    pcm[i] = Math.round(Math.sin(i / 17) * amplitude + (Math.random() - 0.5) * 40)
  }
  return pcm
}

const heard = (wav: Uint8Array): number[] => Array.from(decodeWavPcm16(wav).pcm)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class FakeSettings extends EventEmitter {
  value: Settings = defaultSettings()
  constructor() {
    super()
    // The user's own provider, rule-based formatting only: no formatting model in this test.
    this.value.stt.source = 'custom'
    this.value.stt.baseUrl = 'http://stt.test/v1'
    this.value.stt.model = 'whisper-1'
    this.value.formatting.mode = 'light'
    // Send the audio exactly as heard, so what the provider got can be compared with the clip.
    this.value.audio.trimSilence = false
  }
  get(): Settings {
    return this.value
  }
  patch(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch }
    return this.value
  }
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

describe('a dictation fed by MURMUR_TEST_AUDIO_FILE', () => {
  let dir: string
  let history: HistoryStore
  let recordings: RecordingStore
  let states: OverlayState[]
  let overlaySends: string[]
  let logLines: string[]
  let controller: DictationController
  let hook: {
    waitForKeysUp: () => Promise<boolean>
    beginSynthetic: () => void
    endSynthetic: () => void
    notifySessionStarted: () => void
    notifySessionEnded: ReturnType<typeof vi.fn>
  }
  const clip = speech(3)

  /** Build the app's recording side on a clip (or a directory of clips) at `path`. */
  function build(path: string): void {
    const source = resolveTestAudio({ [TEST_AUDIO_FILE]: path }, true)
    expect(source).not.toBeNull()
    const recorder = new Recorder(
      {
        send: (channel: string) => overlaySends.push(channel),
        whenReady: async () => undefined
      } as never,
      source
    )
    controller = new DictationController({
      settings: new FakeSettings() as never,
      history,
      recorder,
      recordings,
      hook: hook as never,
      inference: inference as never,
      overlay: { setState: (s) => states.push(s), playSound: () => undefined },
      getActiveWindow: async () => ({ title: 'Notes', app: 'notes' })
    })
  }

  /** Wait for the session to end (on its own or by a stop) and for the pipeline to finish. */
  const untilIdle = async (): Promise<void> => {
    for (let i = 0; i < 600 && (controller.isListening || controller.isBusy); i++) await sleep(10)
    expect(controller.isListening).toBe(false)
    expect(controller.isBusy).toBe(false)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-fixture-'))
    writeFileSync(join(dir, 'clip.wav'), encodeWavPcm16(clip, SAMPLE_RATE))
    recordings = new RecordingStore(join(dir, 'recordings'))
    history = new HistoryStore(join(dir, 'data'), recordings)
    states = []
    overlaySends = []
    logLines = []
    inject.calls.length = 0
    provider.wavs.length = 0
    provider.outcome = 'ok'
    provider.text = 'um so hello from murmur this is a test'
    hook = {
      waitForKeysUp: async () => true,
      beginSynthetic: () => undefined,
      endSynthetic: () => undefined,
      notifySessionStarted: () => undefined,
      notifySessionEnded: vi.fn()
    }
    for (const level of ['log', 'warn'] as const)
      vi.spyOn(console, level).mockImplementation((line: unknown) => {
        logLines.push(String(line))
      })
    build(join(dir, 'clip.wav'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('hold: streams the clip in real time while the key is held and dictates what was heard by the release', async () => {
    controller.handle({ type: 'start', mode: 'hold' })
    expect(states.at(-1)).toMatchObject({ phase: 'listening', mode: 'hold', locked: false })
    await sleep(400)
    controller.handle({ type: 'stop' })
    await untilIdle()

    const [entry] = history.list().entries as HistoryEntry[]
    expect(entry.finalText).toBe('So hello from murmur this is a test')
    expect(entry.error).toBeUndefined()
    expect(inject.calls).toEqual([
      { text: 'So hello from murmur this is a test ', method: 'auto', pressEnter: false }
    ])
    expect(states.at(-1)).toMatchObject({ phase: 'success' })
    // 400 ms held: about 0.4 s of audio, not the 3 s clip.
    expect(entry.speechMs).toBeGreaterThanOrEqual(380)
    expect(entry.speechMs).toBeLessThan(1000)
    // The provider heard the beginning of the clip, sample for sample, and nothing else.
    expect(provider.wavs).toHaveLength(1)
    const got = heard(provider.wavs[0])
    expect(Math.round(got.length / (SAMPLE_RATE / 1000))).toBe(entry.speechMs)
    expect(got).toEqual(Array.from(clip.subarray(0, got.length)))
    // The hotkey ended the session, not the clip.
    expect(hook.notifySessionEnded).not.toHaveBeenCalled()
  })

  it('hands-free: plays the clip to its end, then stops on its own like a stop from the user', async () => {
    const short = speech(0.5)
    writeFileSync(join(dir, 'clip.wav'), encodeWavPcm16(short, SAMPLE_RATE))
    controller.handle({ type: 'start', mode: 'hands-free' })
    expect(states.at(-1)).toMatchObject({ phase: 'listening', mode: 'hands-free', locked: true })
    await untilIdle()

    expect(hook.notifySessionEnded).toHaveBeenCalledTimes(1)
    const [entry] = history.list().entries as HistoryEntry[]
    expect(entry.finalText).toBe('So hello from murmur this is a test')
    expect(entry.speechMs).toBe(500)
    expect(heard(provider.wavs[0])).toEqual(Array.from(short))
    expect(inject.calls).toHaveLength(1)
    expect(states.at(-1)).toMatchObject({ phase: 'success' })
    expect(logLines).toContainEqual(
      expect.stringMatching(/fixture audio finished; stopping the hands-free session/)
    )
  })

  it('a tap locks the held session, which then runs to the end of the clip', async () => {
    const short = speech(0.5)
    writeFileSync(join(dir, 'clip.wav'), encodeWavPcm16(short, SAMPLE_RATE))
    controller.handle({ type: 'start', mode: 'hold' })
    await sleep(100)
    controller.handle({ type: 'lock' })
    expect(states.at(-1)).toMatchObject({ phase: 'listening', mode: 'hands-free', locked: true })
    await untilIdle()

    expect(hook.notifySessionEnded).toHaveBeenCalledTimes(1)
    const [entry] = history.list().entries as HistoryEntry[]
    expect(entry.mode).toBe('hands-free')
    expect(entry.speechMs).toBe(500)
    expect(heard(provider.wavs[0])).toEqual(Array.from(short))
  })

  it('press enter: a clip ending in "press enter" types the text and presses Enter', async () => {
    provider.text = 'hello there press enter'
    controller.handle({ type: 'start', mode: 'hold' })
    await sleep(400)
    controller.handle({ type: 'stop' })
    await untilIdle()

    const [entry] = history.list().entries as HistoryEntry[]
    expect(entry.finalText).toBe('Hello there')
    expect(entry.stages).toContain('press-enter')
    expect(inject.calls).toEqual([{ text: 'Hello there ', method: 'auto', pressEnter: true }])
  })

  it('retry: a failed dictation keeps the audio it heard and Retry sends exactly that again', async () => {
    provider.outcome = 'timeout'
    controller.handle({ type: 'start', mode: 'hold' })
    await sleep(400)
    controller.handle({ type: 'stop' })
    await untilIdle()

    const failed = history.list().entries[0]
    expect(failed.error).toBe('The server took too long to respond')
    expect(failed.recording).toBe(`${failed.id}.wav`)
    expect(recordings.has(failed.recording)).toBe(true)
    expect(states.at(-1)).toMatchObject({ phase: 'error', retryId: failed.id })
    const firstHeard = heard(provider.wavs[0])
    expect(firstHeard).toEqual(Array.from(clip.subarray(0, firstHeard.length)))
    // The stored recording is the fixture audio as heard, so Retry replays the same dictation.
    expect(Array.from((await recordings.read(failed.recording)).pcm)).toEqual(firstHeard)

    provider.outcome = 'ok'
    expect(await controller.retry(failed.id, { inject: true })).toEqual({ ok: true })
    expect(provider.wavs).toHaveLength(2)
    expect(heard(provider.wavs[1])).toEqual(firstHeard)
    expect(history.get(failed.id)).toMatchObject({
      finalText: 'So hello from murmur this is a test',
      attempts: 2,
      error: undefined
    })
    expect(inject.calls).toEqual([
      { text: 'So hello from murmur this is a test ', method: 'auto', pressEnter: false }
    ])
    expect(states.at(-1)).toMatchObject({ phase: 'success' })
  })

  it('a directory of clips is cycled through, one per dictation, in name order', async () => {
    const clips = join(dir, 'clips')
    mkdirSync(clips)
    const a = speech(0.4)
    const b = speech(0.4)
    writeFileSync(join(clips, '01-a.wav'), encodeWavPcm16(a, SAMPLE_RATE))
    writeFileSync(join(clips, '02-b.wav'), encodeWavPcm16(b, SAMPLE_RATE))
    build(clips)

    for (let i = 0; i < 3; i++) {
      controller.handle({ type: 'start', mode: 'hands-free' })
      await untilIdle()
    }
    expect(provider.wavs.map(heard)).toEqual([Array.from(a), Array.from(b), Array.from(a)])
    expect(history.list().entries).toHaveLength(3)
    expect(
      logLines.filter((l) =>
        /fixture audio 01-a\.wav \(0\.4 s\) stands in for the microphone/.test(l)
      )
    ).toHaveLength(2)
    expect(
      logLines.filter((l) =>
        /fixture audio 02-b\.wav \(0\.4 s\) stands in for the microphone/.test(l)
      )
    ).toHaveLength(1)
  })

  it('never asks the renderer for audio, and says in the log that the clip is in use', async () => {
    controller.handle({ type: 'start', mode: 'hold' })
    await sleep(200)
    controller.handle({ type: 'stop' })
    await untilIdle()

    // audio:start / audio:stop are how the overlay renderer opens and reads the microphone. A
    // fixture dictation sends neither, so no input device is opened and no renderer ever holds
    // the samples — there is nothing that could reach an output device.
    expect(overlaySends).toEqual([])
    expect(logLines).toContainEqual(
      expect.stringMatching(
        /\[recorder\] session [0-9a-f]{8}: fixture audio clip\.wav \(3\.0 s\) stands in for the microphone/
      )
    )
  })

  it('cancel drops the dictation without a request or an entry', async () => {
    controller.handle({ type: 'start', mode: 'hold' })
    await sleep(150)
    controller.handle({ type: 'cancel' })
    await untilIdle()
    await sleep(150)
    expect(provider.wavs).toHaveLength(0)
    expect(history.list().entries).toHaveLength(0)
    expect(states.at(-1)).toMatchObject({ phase: 'idle' })
  })
})
