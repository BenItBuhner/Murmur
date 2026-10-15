import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { countWords, joinPieces } from '@engine'
import type { DictationMode, HistoryEntry } from '@shared/types'
import { createLogger } from '../logger'

const log = createLogger('partials')

/** What a dictation in progress had transcribed so far, kept on disk until it finishes. */
export interface PartialTranscript {
  id: string
  createdAt: number
  mode: string
  /** Streamed pieces' texts by index (a gap is a piece not back yet). */
  texts: (string | null)[]
  updatedAt: number
}

/**
 * Crash recovery for long dictations: each streamed piece's text is written to `partials/<id>.json`
 * as it comes back, and the file is removed when the dictation finishes either way. A file still
 * there at the next start is a dictation Murmur never finished (a crash, a forced quit, a power
 * cut); its text goes to History instead of being lost with 30 minutes of speech.
 */
export class PartialStore {
  constructor(readonly dir: string) {}

  private fileFor(id: string): string {
    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, '')}.json`)
  }

  save(p: Omit<PartialTranscript, 'updatedAt'>): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = this.fileFor(p.id)
      // Written aside and renamed, so a crash mid-write never leaves half a file.
      writeFileSync(`${file}.tmp`, JSON.stringify({ ...p, updatedAt: Date.now() }))
      renameSync(`${file}.tmp`, file)
    } catch (err) {
      log.warn('could not save a partial transcript', err)
    }
  }

  clear(id: string): void {
    try {
      rmSync(this.fileFor(id), { force: true })
    } catch {
      // nothing to clear
    }
  }

  /** The partials left by dictations that never finished; each is removed as it is read. */
  takeAll(): PartialTranscript[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const out: PartialTranscript[] = []
    for (const name of names) {
      const file = join(this.dir, name)
      try {
        if (name.endsWith('.json')) {
          const p = JSON.parse(readFileSync(file, 'utf8')) as PartialTranscript
          if (p && typeof p.id === 'string' && Array.isArray(p.texts)) out.push(p)
        }
      } catch (err) {
        log.warn(`unreadable partial ${name}`, err)
      }
      rmSync(file, { force: true })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }
}

/** What History says on an entry recovered from a dictation Murmur never finished. */
export const RECOVERED_NOTE =
  'Murmur closed before this dictation finished. This is the text transcribed until then; the end may be missing.'

/** The History entry for a partial left behind, or null when nothing had come back yet. */
export function recoveredEntry(p: PartialTranscript): HistoryEntry | null {
  const text = joinPieces(p.texts.filter((t): t is string => !!t && !!t.trim())).text.trim()
  if (!text) return null
  return {
    id: p.id,
    createdAt: p.createdAt,
    mode: p.mode as DictationMode,
    rawText: text,
    finalText: text,
    wordCount: countWords(text),
    speechMs: 0,
    provider: 'murmur',
    model: '',
    injected: false,
    llmUsed: false,
    stages: ['recovered'],
    timings: { recordMs: 0, vadMs: 0, sttMs: 0, formatMs: 0, llmMs: 0, injectMs: 0, totalMs: 0 },
    error: RECOVERED_NOTE
  }
}
