import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeWavPcm16 } from '@core/audio/wav'
import {
  CHUNK_SAMPLES,
  chunkLevel,
  loadClip,
  resolveTestAudio,
  TestAudioSource,
  TestAudioStream,
  TEST_AUDIO_FILE
} from '../src/main/audio/test-audio'

// The Recorder registers its IPC handlers on construction; outside Electron there is no ipcMain.
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))
import { Recorder } from '../src/main/audio/recorder'

const SR = 16000

function tone(seconds: number, amplitude = 0.5, rate = SR, freq = 220): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++)
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amplitude * 32767)
  return out
}

/** A 16-bit stereo WAV with the same sample on both channels (encodeWavPcm16 only writes mono). */
function stereoWav(pcm: Int16Array, rate: number): Uint8Array {
  const interleaved = new Int16Array(pcm.length * 2)
  for (let i = 0; i < pcm.length; i++) interleaved[i * 2] = interleaved[i * 2 + 1] = pcm[i]
  const wav = encodeWavPcm16(interleaved, rate)
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  view.setUint16(22, 2, true) // channels
  view.setUint32(28, rate * 4, true) // byte rate
  view.setUint16(32, 4, true) // block align
  return wav
}

describe('MURMUR_TEST_AUDIO_FILE', () => {
  let dir: string
  let clip: string
  const pcm = tone(0.5)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-test-audio-'))
    clip = join(dir, 'clip.wav')
    writeFileSync(clip, encodeWavPcm16(pcm, SR))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('resolveTestAudio', () => {
    it('is off without the variable', () => {
      expect(resolveTestAudio({}, true)).toBeNull()
      expect(resolveTestAudio({ [TEST_AUDIO_FILE]: '   ' }, true)).toBeNull()
    })

    it('never applies to packaged builds, however valid the clip', () => {
      expect(resolveTestAudio({ [TEST_AUDIO_FILE]: clip }, false)).toBeNull()
    })

    it('is off for a path that does not exist, a file that is not audio, or a directory without clips', () => {
      const garbage = join(dir, 'garbage.wav')
      writeFileSync(garbage, 'this is not audio at all')
      const notes = join(dir, 'notes.txt')
      writeFileSync(notes, 'hello')
      const empty = join(dir, 'empty')
      mkdirSync(empty)
      const noClips = join(dir, 'no-clips')
      mkdirSync(noClips)
      writeFileSync(join(noClips, 'readme.txt'), 'nothing to hear here')
      writeFileSync(join(noClips, 'broken.wav'), 'RIFF but not really')

      expect(resolveTestAudio({ [TEST_AUDIO_FILE]: join(dir, 'missing.wav') }, true)).toBeNull()
      expect(resolveTestAudio({ [TEST_AUDIO_FILE]: garbage }, true)).toBeNull()
      expect(resolveTestAudio({ [TEST_AUDIO_FILE]: notes }, true)).toBeNull()
      expect(resolveTestAudio({ [TEST_AUDIO_FILE]: empty }, true)).toBeNull()
      expect(resolveTestAudio({ [TEST_AUDIO_FILE]: noClips }, true)).toBeNull()
    })

    it('turns a development build on for a WAV file', () => {
      const source = resolveTestAudio({ [TEST_AUDIO_FILE]: clip }, true)
      expect(source).toMatchObject({ path: resolve(clip), kind: 'file' })
      expect(Array.from(source!.next().pcm)).toEqual(Array.from(pcm))
    })

    it('turns on for a directory with at least one usable clip', () => {
      writeFileSync(join(dir, 'broken.wav'), 'not audio')
      const source = resolveTestAudio({ [TEST_AUDIO_FILE]: dir }, true)
      expect(source).toMatchObject({ path: resolve(dir), kind: 'directory' })
    })
  })

  describe('loadClip', () => {
    it('keeps 16 kHz mono as it is and names the clip after the file', () => {
      const loaded = loadClip(clip)
      expect(loaded.name).toBe('clip.wav')
      expect(Array.from(loaded.pcm)).toEqual(Array.from(pcm))
    })

    it('resamples other rates to 16 kHz', () => {
      const file = join(dir, 'high.wav')
      writeFileSync(file, encodeWavPcm16(tone(0.3, 0.5, 48000), 48000))
      const loaded = loadClip(file)
      expect(Math.abs(loaded.pcm.length - 0.3 * SR)).toBeLessThanOrEqual(2)
      expect(chunkLevel(loaded.pcm)).toBeGreaterThan(0.5)
    })

    it('mixes stereo down to mono', () => {
      const file = join(dir, 'stereo.wav')
      writeFileSync(file, stereoWav(pcm, SR))
      expect(Array.from(loadClip(file).pcm)).toEqual(Array.from(pcm))
    })

    it('reads a headerless .pcm file as 16 kHz mono 16-bit little-endian', () => {
      const file = join(dir, 'raw.pcm')
      const bytes = Buffer.alloc(pcm.length * 2)
      for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(pcm[i], i * 2)
      writeFileSync(file, bytes)
      expect(Array.from(loadClip(file).pcm)).toEqual(Array.from(pcm))
    })

    it('rejects a clip without audio and a file that is neither WAV nor raw PCM', () => {
      const silent = join(dir, 'nothing.wav')
      writeFileSync(silent, encodeWavPcm16(new Int16Array(0), SR))
      expect(() => loadClip(silent)).toThrow(/no audio/)
      const text = join(dir, 'notes.txt')
      writeFileSync(text, 'hello')
      expect(() => loadClip(text)).toThrow(/RIFF/)
      const emptyRaw = join(dir, 'empty.raw')
      writeFileSync(emptyRaw, '')
      expect(() => loadClip(emptyRaw)).toThrow(/no audio/)
    })
  })

  describe('TestAudioSource', () => {
    it('reads the file again for every dictation, so a test can swap the clip', () => {
      const source = new TestAudioSource(clip, 'file')
      expect(source.next().pcm.length).toBe(pcm.length)
      const other = tone(0.2, 0.3)
      writeFileSync(clip, encodeWavPcm16(other, SR))
      expect(Array.from(source.next().pcm)).toEqual(Array.from(other))
    })

    it('cycles through a directory in name order, one clip per dictation', () => {
      const clips = join(dir, 'clips')
      mkdirSync(clips)
      writeFileSync(join(clips, 'b.wav'), encodeWavPcm16(tone(0.1), SR))
      writeFileSync(join(clips, 'a.wav'), encodeWavPcm16(tone(0.2), SR))
      writeFileSync(join(clips, 'c.pcm'), Buffer.alloc(2 * 1600))
      writeFileSync(join(clips, 'notes.txt'), 'ignored')
      const source = new TestAudioSource(clips, 'directory')
      const names = [1, 2, 3, 4].map(() => source.next().name)
      expect(names).toEqual(['a.wav', 'b.wav', 'c.pcm', 'a.wav'])
    })

    it('skips a clip that cannot be read for the next one in the cycle', () => {
      const clips = join(dir, 'clips')
      mkdirSync(clips)
      writeFileSync(join(clips, 'a.wav'), encodeWavPcm16(tone(0.1), SR))
      writeFileSync(join(clips, 'b.wav'), 'went bad')
      const source = new TestAudioSource(clips, 'directory')
      expect(source.next().name).toBe('a.wav')
      expect(source.next().name).toBe('a.wav')
      rmSync(join(clips, 'a.wav'))
      expect(() => source.next()).toThrow(/RIFF/)
    })
  })

  describe('TestAudioStream', () => {
    let clock: number
    let chunks: Array<{ pcm: Int16Array; level: number }>
    let ended: number
    let stream: TestAudioStream

    const advance = (ms: number): void => {
      clock += ms
      vi.advanceTimersByTime(ms)
    }
    const delivered = (): Int16Array => {
      const out = new Int16Array(chunks.reduce((n, c) => n + c.pcm.length, 0))
      let o = 0
      for (const c of chunks) {
        out.set(c.pcm, o)
        o += c.pcm.length
      }
      return out
    }
    const build = (pcm: Int16Array, onEnded?: () => void): TestAudioStream =>
      new TestAudioStream(
        pcm,
        {
          chunk: (p, level) => chunks.push({ pcm: p, level }),
          ended: () => {
            ended++
            onEnded?.()
          }
        },
        { now: () => clock }
      )

    beforeEach(() => {
      vi.useFakeTimers()
      clock = 1000
      chunks = []
      ended = 0
    })
    afterEach(() => {
      stream?.stop()
      vi.useRealTimers()
    })

    it('delivers the clip at the pace of a microphone, in renderer-sized chunks', () => {
      const clip = tone(1)
      stream = build(clip)
      stream.start()
      expect(chunks).toHaveLength(0)
      advance(64)
      expect(stream.delivered).toBe(1024)
      advance(64 * 7)
      expect(stream.delivered).toBe(8192)
      expect(chunks.every((c) => c.pcm.length <= CHUNK_SAMPLES)).toBe(true)
      expect(Array.from(delivered())).toEqual(Array.from(clip.subarray(0, 8192)))
      expect(chunks.every((c) => c.level > 0.5)).toBe(true)
      expect(ended).toBe(0)
      // A slow tick catches up with the clock rather than falling behind it.
      advance(200)
      expect(stream.delivered).toBe(Math.floor(((64 * 8 + 200) / 1000) * SR))
    })

    it('says once when the clip is spent, then delivers silence until stopped', () => {
      const clip = tone(0.1) // 1600 samples
      stream = build(clip)
      stream.start()
      advance(64)
      expect(ended).toBe(0)
      advance(64)
      expect(ended).toBe(1)
      // The clip ended 576 samples into this tick; the rest of the tick is silence.
      expect(stream.delivered).toBe(2048)
      expect(Array.from(delivered().subarray(0, 1600))).toEqual(Array.from(clip))
      expect(Array.from(delivered().subarray(1600))).toEqual(new Array(448).fill(0))
      expect(chunks.at(-1)!.level).toBe(0)
      advance(64 * 3)
      expect(ended).toBe(1)
      expect(stream.delivered).toBe(2048 + 3 * 1024)
      stream.stop()
      advance(64 * 5)
      expect(stream.delivered).toBe(2048 + 3 * 1024)
    })

    it('stopping delivers what was due up to that instant, and never past the clip', () => {
      const clip = tone(1)
      stream = build(clip)
      stream.start()
      advance(64)
      clock += 30 // released 94 ms in, between two ticks
      stream.stop()
      expect(stream.delivered).toBe(Math.floor(0.094 * SR))
      expect(Array.from(delivered())).toEqual(Array.from(clip.subarray(0, stream.delivered)))
      advance(1000)
      expect(stream.delivered).toBe(Math.floor(0.094 * SR))
      expect(ended).toBe(0)

      chunks = []
      stream = build(tone(0.05))
      stream.start()
      clock += 500 // held far past the end without a tick in between
      stream.stop()
      expect(stream.delivered).toBe(800)
    })

    it('a stop on the ended notice leaves exactly the clip and not a sample of silence', () => {
      const clip = tone(0.1)
      stream = build(clip, () => stream.stop())
      stream.start()
      advance(64 * 3)
      expect(ended).toBe(1)
      expect(stream.delivered).toBe(clip.length)
      expect(Array.from(delivered())).toEqual(Array.from(clip))
      expect(chunks.every((c) => c.level > 0)).toBe(true)
    })
  })

  describe('Recorder with a stand-in microphone', () => {
    const overlay = (): { send: ReturnType<typeof vi.fn>; whenReady: () => Promise<void> } => ({
      send: vi.fn(),
      whenReady: () => Promise.resolve()
    })

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('streams the clip into the capture itself; the renderer is never asked for audio', async () => {
      const win = overlay()
      const recorder = new Recorder(win as never, new TestAudioSource(clip, 'file'))
      const chunks: number[] = []
      const ended: string[] = []
      recorder.on('chunk', (_id: string, samples: number) => chunks.push(samples))
      recorder.on('ended', (id: string) => ended.push(id))

      recorder.start('s1', true)
      vi.advanceTimersByTime(64 * 4)
      expect(recorder.samplesFor('s1')).toBe(4096)
      expect(chunks).toEqual([1024, 2048, 3072, 4096])
      expect(recorder.lastLevel).toBeGreaterThan(0.5)
      const heard = await recorder.stop('s1')
      expect(Array.from(heard)).toEqual(Array.from(pcm.subarray(0, 4096)))
      expect(ended).toEqual([])
      // No audio:start / audio:stop went to the overlay renderer, so no device was touched.
      expect(win.send).not.toHaveBeenCalled()
    })

    it('reports the end of the clip and resolves stop at once with everything heard', async () => {
      const win = overlay()
      const recorder = new Recorder(win as never, new TestAudioSource(clip, 'file'))
      const ended: string[] = []
      recorder.on('ended', (id: string) => ended.push(id))
      recorder.start('s2', false)
      vi.advanceTimersByTime(64 * 9)
      expect(ended).toEqual(['s2'])
      expect(recorder.samplesFor('s2')).toBe(9 * 1024)
      let resolved: Int16Array | null = null
      void recorder.stop('s2').then((p) => (resolved = p))
      await Promise.resolve()
      expect(resolved).not.toBeNull()
      expect(Array.from(resolved!.subarray(0, pcm.length))).toEqual(Array.from(pcm))
      expect(resolved!.length).toBe(9 * 1024)
      expect(win.send).not.toHaveBeenCalled()
    })

    it('cancel drops the capture and the stream', () => {
      const win = overlay()
      const recorder = new Recorder(win as never, new TestAudioSource(clip, 'file'))
      recorder.start('s3', false)
      vi.advanceTimersByTime(64 * 2)
      recorder.cancel('s3')
      vi.advanceTimersByTime(64 * 5)
      expect(recorder.samplesFor('s3')).toBe(0)
      expect(win.send).not.toHaveBeenCalled()
    })

    it('without a source (packaged, unset, garbage path) the renderer records as before', () => {
      for (const source of [
        resolveTestAudio({ [TEST_AUDIO_FILE]: clip }, false),
        resolveTestAudio({}, true),
        resolveTestAudio({ [TEST_AUDIO_FILE]: join(dir, 'nope.wav') }, true)
      ]) {
        expect(source).toBeNull()
        const win = overlay()
        const recorder = new Recorder(win as never, source)
        recorder.start('s4', true)
        expect(win.send).toHaveBeenCalledWith('audio:start', {
          sessionId: 's4',
          includePreBuffer: true
        })
        recorder.cancel('s4')
        expect(win.send).toHaveBeenCalledWith('audio:stop', { sessionId: 's4' })
      }
    })
  })
})
