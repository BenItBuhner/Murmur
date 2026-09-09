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

/** Where the entries' audio lives, so a recording never outlives its entry. */
export interface RecordingSink {
  delete(name: string | undefined): void
}

export class HistoryStore extends EventEmitter {
  private store: JsonStore<HistoryEntry[]>

  constructor(
    userDataPath: string,
    private readonly recordings: RecordingSink | null = null
  ) {
    super()
    this.store = new JsonStore<HistoryEntry[]>(
      join(userDataPath, 'history.json'),
      parseHistory,
      300
    )
  }

  add(entry: HistoryEntry): void {
    const current = this.store.get()
    const list = [entry, ...current.filter((e) => e.id !== entry.id)]
    this.commit(list.slice(0, MAX_ENTRIES), current, list.slice(MAX_ENTRIES))
    this.emit('added', entry)
    this.emit('changed')
  }

  /**
   * A dictation sent again: the entry keeps its place in the list (and its date) and only its
   * outcome changes. Falls back to `add` when the entry is gone.
   */
  replace(entry: HistoryEntry): void {
    const current = this.store.get()
    const index = current.findIndex((e) => e.id === entry.id)
    if (index < 0) {
      this.add(entry)
      return
    }
    const list = current.slice()
    list[index] = entry
    this.commit(list, current)
    this.emit('replaced', entry)
    this.emit('changed')
  }

  /** The user deleted every recording: the entries stay, their audio references go. */
  stripRecordings(): void {
    const current = this.store.get()
    if (!current.some((e) => e.recording)) return
    const next = current.map((e) => {
      if (!e.recording) return e
      const rest: HistoryEntry = { ...e }
      delete rest.recording
      return rest
    })
    this.commit(next, current)
    this.emit('changed')
  }

  /** Every recording file the current entries refer to. */
  recordingNames(): Set<string> {
    const names = new Set<string>()
    for (const e of this.store.get()) if (e.recording) names.add(e.recording)
    return names
  }

  /**
   * Persist `next`, deleting the recordings of entries that are no longer in it. `evicted` are
   * entries that fell off the end of the list and are not in `next` either.
   */
  private commit(
    next: HistoryEntry[],
    previous: HistoryEntry[],
    evicted: HistoryEntry[] = []
  ): void {
    this.store.set(next)
    if (!this.recordings) return
    const kept = new Set<string>()
    for (const e of next) if (e.recording) kept.add(e.recording)
    for (const e of [...previous, ...evicted]) {
      if (e.recording && !kept.has(e.recording)) this.recordings.delete(e.recording)
    }
  }

  list(limit = 100, offset = 0): { entries: HistoryEntry[]; total: number } {
    const all = this.store.get()
    return { entries: all.slice(offset, offset + limit), total: all.length }
  }

  get(id: string): HistoryEntry | undefined {
    return this.store.get().find((e) => e.id === id)
  }

  delete(id: string, origin: HistoryOrigin = 'local'): void {
    const current = this.store.get()
    this.commit(
      current.filter((e) => e.id !== id),
      current
    )
    this.emit('deleted', id, origin)
    this.emit('changed')
  }

  clear(origin: HistoryOrigin = 'local'): void {
    this.commit([], this.store.get())
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
    this.commit(next, current)
    this.emit('changed')
  }

  /** Drop entries that came from other devices (history sync turned off or user signed out). */
  removeRemote(): void {
    const current = this.store.get()
    const next = current.filter((e) => !e.remote)
    if (next.length === current.length) return
    this.commit(next, current)
    this.emit('changed')
  }

  replaceAll(entries: HistoryEntry[], origin: HistoryOrigin = 'local'): void {
    this.commit(entries.slice(0, MAX_ENTRIES), this.store.get())
    this.emit('cleared', origin)
    this.emit('changed')
  }

  flush(): void {
    this.store.flush()
  }
}
