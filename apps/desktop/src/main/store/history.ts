import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { HistoryEntry } from '@shared/types'
import { JsonStore } from './json-store'

const MAX_ENTRIES = 2000

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
    const list = [entry, ...this.store.get()].slice(0, MAX_ENTRIES)
    this.store.set(list)
    this.emit('added', entry)
  }

  list(limit = 100, offset = 0): { entries: HistoryEntry[]; total: number } {
    const all = this.store.get()
    return { entries: all.slice(offset, offset + limit), total: all.length }
  }

  get(id: string): HistoryEntry | undefined {
    return this.store.get().find((e) => e.id === id)
  }

  delete(id: string): void {
    this.store.set(this.store.get().filter((e) => e.id !== id))
    this.emit('changed')
  }

  clear(): void {
    this.store.set([])
    this.emit('changed')
  }

  flush(): void {
    this.store.flush()
  }
}
