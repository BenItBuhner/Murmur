import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeWavPcm16, encodeWavPcm16 } from '@core/audio/wav'
import type { RecordingsInfo } from '@shared/ipc'
import { createLogger } from '../logger'

const log = createLogger('recordings')

/** 16 kHz mono PCM is ~1.9 MB per minute; half a gigabyte is roughly four hours of speech. */
export const DEFAULT_RECORDINGS_BUDGET_BYTES = 500 * 1024 * 1024

/** Younger than this, a file without an entry is a dictation being processed, not an orphan. */
export const IN_FLIGHT_MS = 60_000

const FILE_NAME = /^[A-Za-z0-9_-]+\.wav$/

/**
 * The audio behind History entries: one WAV per dictation in `recordings/`, named after the entry.
 * Files are what make "send it again" possible after a failed request, and what the History page
 * plays back. The directory is kept under a byte budget (oldest files go first) and swept of files
 * whose entry is gone.
 */
export class RecordingStore {
  constructor(
    readonly dir: string,
    private readonly budgetBytes = DEFAULT_RECORDINGS_BUDGET_BYTES
  ) {}

  /** File name for a history entry id; ids are UUIDs, so the name is always a safe path segment. */
  static fileFor(id: string): string {
    return `${id.replace(/[^A-Za-z0-9_-]/g, '')}.wav`
  }

  pathFor(name: string): string {
    if (!FILE_NAME.test(name)) throw new Error(`Not a recording file name: ${name}`)
    return join(this.dir, name)
  }

  has(name: string | undefined): name is string {
    return !!name && FILE_NAME.test(name) && existsSync(join(this.dir, name))
  }

  /** Write the dictation's audio as WAV and return the file name to store on the entry. */
  async save(id: string, pcm: Int16Array, sampleRate: number): Promise<string> {
    const name = RecordingStore.fileFor(id)
    mkdirSync(this.dir, { recursive: true })
    await writeFile(join(this.dir, name), encodeWavPcm16(pcm, sampleRate))
    this.prune()
    return name
  }

  async readBytes(name: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(name)))
  }

  async read(name: string): Promise<{ pcm: Int16Array; sampleRate: number }> {
    const wav = decodeWavPcm16(await this.readBytes(name))
    return { pcm: wav.pcm, sampleRate: wav.sampleRate }
  }

  delete(name: string | undefined): void {
    if (!name || !FILE_NAME.test(name)) return
    try {
      rmSync(join(this.dir, name), { force: true })
    } catch (err) {
      log.warn(`could not delete ${name}`, err)
    }
  }

  clear(): void {
    for (const f of this.files()) this.delete(f.name)
  }

  info(): RecordingsInfo {
    const files = this.files()
    return { count: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) }
  }

  /** Drop the oldest files until the directory fits the budget. */
  prune(): void {
    const files = this.files().sort((a, b) => a.mtime - b.mtime)
    let total = files.reduce((n, f) => n + f.bytes, 0)
    for (const f of files) {
      if (total <= this.budgetBytes) break
      this.delete(f.name)
      total -= f.bytes
    }
  }

  /**
   * Delete every file that no history entry refers to (entries evicted, files left behind). A file
   * written moments ago belongs to a dictation still in flight, whose entry is not there yet.
   */
  sweep(keep: ReadonlySet<string>, now = Date.now()): void {
    let removed = 0
    for (const f of this.files()) {
      if (keep.has(f.name) || now - f.mtime < IN_FLIGHT_MS) continue
      this.delete(f.name)
      removed++
    }
    if (removed) log.info(`removed ${removed} orphaned recording(s)`)
  }

  private files(): Array<{ name: string; bytes: number; mtime: number }> {
    if (!existsSync(this.dir)) return []
    const out: Array<{ name: string; bytes: number; mtime: number }> = []
    for (const name of readdirSync(this.dir)) {
      if (!FILE_NAME.test(name)) continue
      try {
        const st = statSync(join(this.dir, name))
        out.push({ name, bytes: st.size, mtime: st.mtimeMs })
      } catch {
        // Deleted underneath us; nothing to account for.
      }
    }
    return out
  }
}
