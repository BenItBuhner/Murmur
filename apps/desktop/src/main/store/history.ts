import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { HistoryEntry } from '@shared/types'
import { JsonStore } from './json-store'

const MAX_ENTRIES = 2000

/** Who made a change: the user on this device, or the sync engine mirroring the account. */
export type HistoryOrigin = 'local' | 'cloud'

function parseHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (e): e is HistoryEntry =>
      !!e && typeof e === 'object' && typeof (e as HistoryEntry).id === 'string'
  )
}

export class HistoryStore extends EventEmitter {
  private store: JsonStore<HistoryEntry[]>

  constructor(userDataPath: string) {
    super()
    this.store = new JsonStore<HistoryEntry[]>(
      join(userDataPath, 'history.json'),
      parseHistory,
      300
    )
  }

  add(entry: HistoryEntry): void {
    const list = [entry, ...this.store.get().filter((e) => e.id !== entry.id)].slice(0, MAX_ENTRIES)
    this.store.set(list)
    this.emit('added', entry)
    this.emit('changed')
  }

  list(limit = 100, offset = 0): { entries: HistoryEntry[]; total: number } {
    const all = this.store.get()
    return { entries: all.slice(offset, offset + limit), total: all.length }
  }

  get(id: string): HistoryEntry | undefined {
    return this.store.get().find((e) => e.id === id)
  }

  delete(id: string, origin: HistoryOrigin = 'local'): void {
    this.store.set(this.store.get().filter((e) => e.id !== id))
    this.emit('deleted', id, origin)
    this.emit('changed')
  }

  clear(origin: HistoryOrigin = 'local'): void {
    this.store.set([])
    this.emit('cleared', origin)
    this.emit('changed')
  }

  /**
   * Fold in entries dictated on the account's other devices. Entries already known (by id) are left
   * alone so local timing data is never overwritten; remote entries that vanished upstream are
   * dropped. Ordered newest first, like local history.
   */
  mergeRemote(remote: readonly HistoryEntry[]): void {
    const current = this.store.get()
    const localIds = new Set(current.filter((e) => !e.remote).map((e) => e.id))
    const remoteIds = new Set(remote.map((e) => e.id))
    const kept = current.filter((e) => !e.remote || remoteIds.has(e.id))
    const keptIds = new Set(kept.map((e) => e.id))
    const additions = remote.filter((e) => !localIds.has(e.id) && !keptIds.has(e.id))
    if (!additions.length && kept.length === current.length) return
    const next = [...kept, ...additions]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ENTRIES)
    this.store.set(next)
    this.emit('changed')
  }

  /** Drop entries that came from other devices (history sync turned off or user signed out). */
  removeRemote(): void {
    const current = this.store.get()
    const next = current.filter((e) => !e.remote)
    if (next.length === current.length) return
    this.store.set(next)
    this.emit('changed')
  }

  replaceAll(entries: HistoryEntry[], origin: HistoryOrigin = 'local'): void {
    this.store.set(entries.slice(0, MAX_ENTRIES))
    this.emit('cleared', origin)
    this.emit('changed')
  }

  flush(): void {
    this.store.flush()
  }
}
