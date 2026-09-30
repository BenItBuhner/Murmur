import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { rmsDb } from '@core/audio/vad'
import { decodeWavPcm16, float32ToInt16, resampleLinear } from '@core/audio/wav'
import { createLogger } from '../logger'

const log = createLogger('test-audio')

/**
 * Environment knob: a 16-bit WAV or raw 16 kHz PCM clip, or a directory of them, that stands in
 * for the microphone in a development build. Packaged builds ignore it.
 */
export const TEST_AUDIO_FILE = 'MURMUR_TEST_AUDIO_FILE'

export const SAMPLE_RATE = 16000
/** The renderer's chunking (1024 samples, 64 ms at 16 kHz); the stand-in delivers the same shape. */
export const CHUNK_SAMPLES = 1024
const TICK_MS = (CHUNK_SAMPLES / SAMPLE_RATE) * 1000
const EXTENSIONS = new Set(['.wav', '.pcm', '.raw'])

export interface TestAudioClip {
  /** File name, for the log. */
  name: string
  /** 16 kHz mono PCM, whatever the file held. */
  pcm: Int16Array
}

/**
 * Development-only stand-in for the microphone: with `MURMUR_TEST_AUDIO_FILE` set, a dev build
 * feeds every dictation from the clip (or the clips) on disk instead of the input device, so the
 * whole in-app flow can be driven on a machine that must neither record nor play audio. The clip
 * is read again for every dictation, so a test can swap it between two; a directory is cycled
 * through in name order, one clip per dictation. Packaged builds ignore the variable; a path that
 * does not exist or holds nothing decodable leaves the microphone in use.
 */
export function resolveTestAudio(
  env: Record<string, string | undefined>,
  allowed: boolean
): TestAudioSource | null {
  const raw = (env[TEST_AUDIO_FILE] ?? '').trim()
  if (!raw) return null
  if (!allowed) {
    log.warn(`${TEST_AUDIO_FILE} is ignored in packaged builds`)
    return null
  }
  const path = resolve(raw)
  let directory: boolean
  try {
    directory = statSync(path).isDirectory()
  } catch {
    log.warn(`${TEST_AUDIO_FILE}: ${path} does not exist; the microphone stays in use`)
    return null
  }
  if (directory) {
    const usable = listClips(path).filter((file) => {
      try {
        loadClip(file)
        return true
      } catch (err) {
        log.warn(`${TEST_AUDIO_FILE}: skipping ${file}: ${describe(err)}`)
        return false
      }
    })
    if (!usable.length) {
      log.warn(
        `${TEST_AUDIO_FILE}: ${path} holds no usable .wav/.pcm/.raw clip; the microphone stays in use`
      )
      return null
    }
    return new TestAudioSource(path, 'directory')
  }
  try {
    loadClip(path)
  } catch (err) {
    log.warn(
      `${TEST_AUDIO_FILE}: ${path} is not a usable clip (${describe(err)}); the microphone stays in use`
    )
    return null
  }
  return new TestAudioSource(path, 'file')
}

/** Where the clips come from: one file, read again for every dictation, or a directory cycled through. */
export class TestAudioSource {
  private served = 0

  constructor(
    readonly path: string,
    readonly kind: 'file' | 'directory'
  ) {}

  /** The clip for the next dictation. Throws when nothing at the path can be read any more. */
  next(): TestAudioClip {
    if (this.kind === 'file') return loadClip(this.path)
    const files = listClips(this.path)
    if (!files.length) throw new Error(`${this.path} holds no .wav/.pcm/.raw clip`)
    const first = this.served++ % files.length
    let failure: unknown = null
    // A clip that went bad since startup is skipped for the next one in the cycle.
    for (let i = 0; i < files.length; i++) {
      const file = files[(first + i) % files.length]
      try {
        return loadClip(file)
      } catch (err) {
        failure = err
        log.warn(`skipping ${file}: ${describe(err)}`)
      }
    }
    throw failure instanceof Error ? failure : new Error(String(failure))
  }
}

/**
 * Read one clip as 16 kHz mono PCM: a RIFF/WAVE file with 16-bit samples (any rate, any channel
 * count: resampled and mixed down), or a headerless `.pcm` / `.raw` file of 16-bit little-endian
 * mono samples at 16 kHz, which is what the recorder itself produces.
 */
export function loadClip(file: string): TestAudioClip {
  const bytes = new Uint8Array(readFileSync(file))
  const name = basename(file)
  if (isRiffWave(bytes)) {
    const wav = decodeWavPcm16(bytes)
    if (!(wav.sampleRate > 0)) throw new Error(`invalid sample rate ${wav.sampleRate}`)
    const pcm = toSampleRate(wav.pcm, wav.sampleRate)
    if (!pcm.length) throw new Error('holds no audio')
    return { name, pcm }
  }
  const ext = extname(file).toLowerCase()
  if (ext === '.pcm' || ext === '.raw') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const pcm = new Int16Array(Math.floor(bytes.byteLength / 2))
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true)
    if (!pcm.length) throw new Error('holds no audio')
    return { name, pcm }
  }
  throw new Error('not a RIFF/WAVE file')
}

function isRiffWave(bytes: Uint8Array): boolean {
  const tag = (o: number): string => String.fromCharCode(...bytes.subarray(o, o + 4))
  return bytes.byteLength >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE'
}

function toSampleRate(pcm: Int16Array, rate: number): Int16Array {
  if (rate === SAMPLE_RATE) return pcm
  const samples = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768
  return float32ToInt16(resampleLinear(samples, rate, SAMPLE_RATE))
}

function listClips(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => EXTENSIONS.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(dir, name))
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The pill's meter scale: -50 dBFS (room noise) .. -10 dBFS (loud speech) onto 0..1. */
export function chunkLevel(pcm: Int16Array): number {
  return Math.max(0, Math.min(1, (rmsDb(pcm) + 50) / 40))
}

export interface TestAudioSink {
  chunk: (pcm: Int16Array, level: number) => void
  /** The clip has been delivered in full. Silence follows until the stream is stopped. */
  ended: () => void
}

export interface TestAudioStreamOptions {
  /** Monotonic clock in milliseconds (tests drive it by hand). */
  now?: () => number
}

/**
 * Plays a clip into a sink at the pace a microphone delivers audio: 16 000 samples per second,
 * in slices no longer than the renderer's 64 ms chunks, as many as the clock says are due at each
 * tick. When the clip is spent the sink is told once, then hears silence until the stream is
 * stopped — a held key keeps "recording" the quiet room, while a hands-free session ends on the
 * notice. Stopping delivers what was due up to that instant, so a key released 3.0 s in yields
 * 3.0 s of audio.
 */
export class TestAudioStream {
  /** Samples delivered so far, clip and silence together. */
  private position = 0
  private startedAt = 0
  private spent = false
  private running = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly pcm: Int16Array,
    private readonly sink: TestAudioSink,
    private readonly opts: TestAudioStreamOptions = {}
  ) {}

  get delivered(): number {
    return this.position
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.startedAt = this.now()
    this.schedule()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.deliverClip(Math.min(this.due(), this.pcm.length))
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : performance.now()
  }

  /** How many samples a microphone would have produced since the start. */
  private due(): number {
    return Math.floor(((this.now() - this.startedAt) / 1000) * SAMPLE_RATE)
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
    }, TICK_MS)
  }

  private tick(): void {
    if (!this.running) return
    const due = this.due()
    this.deliverClip(Math.min(due, this.pcm.length))
    if (!this.spent && this.position >= this.pcm.length) {
      this.spent = true
      this.sink.ended()
      // The sink may have stopped the stream on the notice: then not a sample of silence follows.
      if (!this.running) return
    }
    if (this.spent) this.deliverSilence(due)
    if (this.running) this.schedule()
  }

  private deliverClip(upTo: number): void {
    while (this.position < upTo) {
      const end = Math.min(upTo, this.position + CHUNK_SAMPLES)
      const slice = this.pcm.subarray(this.position, end)
      this.position = end
      this.sink.chunk(slice, chunkLevel(slice))
    }
  }

  private deliverSilence(upTo: number): void {
    while (this.position < upTo) {
      const n = Math.min(CHUNK_SAMPLES, upTo - this.position)
      this.position += n
      this.sink.chunk(new Int16Array(n), 0)
    }
  }
}
