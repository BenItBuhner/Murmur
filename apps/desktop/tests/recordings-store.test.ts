import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RecordingStore } from '../src/main/store/recordings'

const SAMPLE_RATE = 16000

function tone(seconds: number): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 20) * 12000)
  return pcm
}

describe('RecordingStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-recordings-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('stores a dictation as WAV and reads the same samples back', async () => {
    const store = new RecordingStore(join(dir, 'recordings'))
    const pcm = tone(1.5)
    const name = await store.save('7f2c1b7e-0000-4000-8000-000000000001', pcm, SAMPLE_RATE)
    expect(name).toBe('7f2c1b7e-0000-4000-8000-000000000001.wav')
    expect(store.has(name)).toBe(true)
    const back = await store.read(name)
    expect(back.sampleRate).toBe(SAMPLE_RATE)
    expect(Array.from(back.pcm)).toEqual(Array.from(pcm))
    expect(store.info()).toEqual({ count: 1, bytes: 44 + pcm.length * 2 })
  })

  it('has() rejects missing files and anything that is not a recording name', () => {
    const store = new RecordingStore(dir)
    expect(store.has(undefined)).toBe(false)
    expect(store.has('missing.wav')).toBe(false)
    expect(store.has('../settings.json')).toBe(false)
    expect(() => store.pathFor('../escape.wav')).toThrow()
  })

  it('deletes single files, everything, and files no entry refers to', async () => {
    const store = new RecordingStore(dir)
    const a = await store.save('a', tone(0.2), SAMPLE_RATE)
    const b = await store.save('b', tone(0.2), SAMPLE_RATE)
    const c = await store.save('c', tone(0.2), SAMPLE_RATE)
    writeFileSync(join(dir, 'notes.txt'), 'not audio')

    store.delete(a)
    expect(store.has(a)).toBe(false)
    expect(store.info().count).toBe(2)

    store.sweep(new Set([b]))
    expect(store.has(b)).toBe(true)
    expect(store.has(c)).toBe(false)

    store.clear()
    expect(store.info()).toEqual({ count: 0, bytes: 0 })
  })

  it('prunes the oldest recordings once the directory exceeds its budget', async () => {
    const fileBytes = 44 + tone(1).length * 2
    const store = new RecordingStore(dir, fileBytes * 2 + 10)
    const old = await store.save('old', tone(1), SAMPLE_RATE)
    // Make "old" clearly older than what follows regardless of file system timestamp granularity.
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, old), past, past)
    const mid = await store.save('mid', tone(1), SAMPLE_RATE)
    const fresh = await store.save('fresh', tone(1), SAMPLE_RATE)

    expect(store.has(old)).toBe(false)
    expect(store.has(mid)).toBe(true)
    expect(store.has(fresh)).toBe(true)
    expect(store.info().count).toBe(2)
  })
})
