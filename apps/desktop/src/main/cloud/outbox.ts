import { join } from 'node:path'
import { JsonStore } from '../store/json-store'
import type { OutboxOp } from './reducers'

interface OutboxFile {
  /** Clerk user id the queued operations belong to; a different user discards the queue. */
  userId: string
  ops: OutboxOp[]
}

function parseOutbox(raw: unknown): OutboxFile {
  if (!raw || typeof raw !== 'object') return { userId: '', ops: [] }
  const file = raw as Partial<OutboxFile>
  return {
    userId: typeof file.userId === 'string' ? file.userId : '',
    ops: Array.isArray(file.ops)
      ? file.ops.filter(
          (op): op is OutboxOp =>
            !!op &&
            typeof op === 'object' &&
            typeof (op as OutboxOp).id === 'string' &&
            typeof (op as OutboxOp).kind === 'string'
        )
      : []
  }
}

/**
 * Durable queue of local changes waiting for the server. Survives restarts and offline periods;
 * every operation is idempotent on the server so a replay after a crash is safe.
 */
export class Outbox {
  private store: JsonStore<OutboxFile>

  constructor(userDataPath: string) {
    this.store = new JsonStore<OutboxFile>(join(userDataPath, 'sync-outbox.json'), parseOutbox, 100)
  }

  get userId(): string {
    return this.store.get().userId
  }

  get ops(): readonly OutboxOp[] {
    return this.store.get().ops
  }

  get size(): number {
    return this.store.get().ops.length
  }

  /** Bind the queue to an account; ops queued for someone else are dropped. */
  bind(userId: string): void {
    const current = this.store.get()
    if (current.userId !== userId) this.store.set({ userId, ops: [] })
  }

  update(fn: (ops: OutboxOp[]) => OutboxOp[]): void {
    const current = this.store.get()
    this.store.set({ userId: current.userId, ops: fn([...current.ops]) })
  }

  remove(opId: string): void {
    this.update((ops) => ops.filter((op) => op.id !== opId))
  }

  clear(): void {
    this.store.set({ userId: '', ops: [] })
  }

  flush(): void {
    this.store.flush()
  }
}
