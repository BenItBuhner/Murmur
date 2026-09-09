import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import { HistoryStore, type RecordingSink } from '../src/main/store/history'

function entry(id: string, patch: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    createdAt: 1000 + id.charCodeAt(0),
    mode: 'hold',
    rawText: `raw ${id}`,
    finalText: `final ${id}`,
    wordCount: 2,
    speechMs: 1200,
    provider: 'openai-compatible',
    model: 'whisper-1',
    injected: true,
    llmUsed: false,
    timings: {
      recordMs: 1200,
      vadMs: 1,
      sttMs: 300,
      formatMs: 2,
      llmMs: 0,
      injectMs: 20,
      totalMs: 330
    },
    ...patch
  }
}

class FakeSink implements RecordingSink {
  deleted: string[] = []
  delete(name: string | undefined): void {
    if (name) this.deleted.push(name)
  }
}

describe('HistoryStore', () => {
  let dir: string
  let sink: FakeSink
  let store: HistoryStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-history-'))
    sink = new FakeSink()
    store = new HistoryStore(dir, sink)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('replace() keeps the entry where it was and swaps its outcome', () => {
    store.add(entry('a', { finalText: '', error: 'Timed out', recording: 'a.wav' }))
    store.add(entry('b'))
    store.add(entry('c'))
    const replaced: HistoryEntry[] = []
    store.on('replaced', (e: HistoryEntry) => replaced.push(e))

    store.replace(entry('a', { finalText: 'now it worked', recording: 'a.wav', attempts: 2 }))

    expect(store.list().entries.map((e) => e.id)).toEqual(['c', 'b', 'a'])
    expect(store.get('a')?.finalText).toBe('now it worked')
    expect(store.get('a')?.attempts).toBe(2)
    expect(replaced.map((e) => e.id)).toEqual(['a'])
    // Same file on both versions: nothing to delete.
    expect(sink.deleted).toEqual([])
  })

  it('replace() of an unknown id behaves like add()', () => {
    store.replace(entry('z'))
    expect(store.list().entries.map((e) => e.id)).toEqual(['z'])
  })

  it('drops a recording when its entry is deleted, cleared, or replaced without it', () => {
    store.add(entry('a', { recording: 'a.wav' }))
    store.add(entry('b', { recording: 'b.wav' }))
    store.add(entry('c', { recording: 'c.wav' }))

    store.replace(entry('a', { recording: undefined }))
    expect(sink.deleted).toEqual(['a.wav'])

    store.delete('b')
    expect(sink.deleted).toEqual(['a.wav', 'b.wav'])

    store.clear()
    expect(sink.deleted).toEqual(['a.wav', 'b.wav', 'c.wav'])
  })

  it('stripRecordings() keeps the entries but forgets and deletes their audio', () => {
    store.add(entry('a', { recording: 'a.wav' }))
    store.add(entry('b'))
    store.stripRecordings()
    expect(store.get('a')?.recording).toBeUndefined()
    expect(store.get('b')).toBeDefined()
    expect(store.recordingNames().size).toBe(0)
    expect(sink.deleted).toEqual(['a.wav'])
  })

  it('recordingNames() lists the files entries refer to and the file round-trips through disk', () => {
    store.add(entry('a', { recording: 'a.wav' }))
    store.add(entry('b'))
    expect([...store.recordingNames()]).toEqual(['a.wav'])
    store.flush()
    const raw = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')) as HistoryEntry[]
    expect(raw.find((e) => e.id === 'a')?.recording).toBe('a.wav')
    const reopened = new HistoryStore(dir, sink)
    expect(reopened.get('a')?.recording).toBe('a.wav')
  })
})
