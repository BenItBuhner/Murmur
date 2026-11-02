import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MicCapture } from '../src/renderer/src/overlay/capture'

// The renderer's stop: a stop main saw as quiet skips the post-roll, unless the newest audio
// (which main has not seen yet) is louder than main's speech threshold.
describe('MicCapture.stop', () => {
  let stopped: Array<[string, number]>
  let cap: MicCapture
  let flushed: number[]
  // What the worklet hands over on 'flush': the partly filled buffer and its RMS.
  let nextFlushRms = 0

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { mediaDevices: { addEventListener: () => undefined } })
    stopped = []
    flushed = []
    cap = new MicCapture({
      onChunk: () => undefined,
      onLevel: () => undefined,
      onStatus: () => undefined,
      onStopped: (id, n) => stopped.push([id, n])
    })
    const c = cap as unknown as {
      session: { id: string; samples: number } | null
      node: { port: { postMessage: (m: string) => void } }
      onChunk: (pcm: ArrayBuffer, rms: number) => void
    }
    c.session = { id: 's1', samples: 0 }
    c.node = {
      port: {
        postMessage: () => {
          flushed.push(Date.now())
          c.onChunk(new ArrayBuffer(200), nextFlushRms)
        }
      }
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the post-roll by default', () => {
    cap.stop('s1')
    vi.advanceTimersByTime(150)
    expect(flushed).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(flushed).toHaveLength(1)
    expect(stopped).toEqual([['s1', 100]])
  })

  it('a quiet stop flushes at once', () => {
    nextFlushRms = 0.0005 // about -66 dBFS
    cap.stop('s1', false, -48)
    vi.advanceTimersByTime(25)
    expect(flushed).toHaveLength(1)
    expect(stopped).toEqual([['s1', 100]])
  })

  it('a word starting as the key came up gets the post-roll after all', () => {
    nextFlushRms = 0.05 // about -26 dBFS
    cap.stop('s1', false, -48)
    vi.advanceTimersByTime(25)
    expect(stopped).toHaveLength(0)
    vi.advanceTimersByTime(250)
    expect(flushed).toHaveLength(2)
    expect(stopped).toEqual([['s1', 200]])
  })
})
