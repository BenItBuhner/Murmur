import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '../logger'

const log = createLogger('store')

/**
 * Tiny atomic JSON persistence: write to a temp file then rename, debounced so bursts of
 * settings changes hit the disk once. No native dependencies, works inside asar-less userData.
 */
export class JsonStore<T> {
  private data: T
  private timer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(
    private readonly file: string,
    private readonly parse: (raw: unknown) => T,
    private readonly debounceMs = 150
  ) {
    this.data = this.load()
  }

  private load(): T {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
        return this.parse(raw)
      }
    } catch (err) {
      log.warn(`Could not read ${this.file}; starting fresh`, err)
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        // ignore
      }
    }
    return this.parse(undefined)
  }

  get(): T {
    return this.data
  }

  set(next: T): void {
    this.data = next
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.debounceMs)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      log.error(`Failed to write ${this.file}`, err)
    }
  }
}
