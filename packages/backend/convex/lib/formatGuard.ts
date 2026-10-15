/**
 * Per-user guards for `POST /v1/format`, kept in the isolate that serves the request (the Worker's
 * isolate, or a Convex HTTP action's). They exist so that a client stuck re-sending, or many
 * pieces of one long dictation at once, cannot turn into a flood against the formatting provider:
 *
 * - identical requests from one user that are already in flight share one answer (dedupe);
 * - at most FORMAT_MAX_CONCURRENT model-backed formats per user at a time;
 * - at most FORMAT_MAX_PER_MINUTE model-backed formats per user per rolling minute.
 *
 * A request over a limit is not refused: it gets the engine's rule-based text at once, so the
 * dictation still lands and the provider is not asked.
 */
export const FORMAT_MAX_CONCURRENT = 3
export const FORMAT_MAX_PER_MINUTE = 40
const WINDOW_MS = 60_000
/** Users tracked at most; the oldest entries are dropped beyond it. */
const MAX_USERS = 5000

interface UserState {
  active: number
  starts: number[]
}

const users = new Map<string, UserState>()
const inflight = new Map<string, Promise<unknown>>()

function stateOf(userId: string): UserState {
  let s = users.get(userId)
  if (!s) {
    if (users.size >= MAX_USERS) {
      const oldest = users.keys().next().value
      if (oldest !== undefined) users.delete(oldest)
    }
    s = { active: 0, starts: [] }
    users.set(userId, s)
  }
  return s
}

/**
 * Whether one more model-backed format may start for `userId` at `now`. On `true` the caller
 * must call `release(userId)` when done.
 */
export function admitFormat(
  userId: string,
  now = Date.now()
): { ok: true } | { ok: false; reason: 'concurrency' | 'rate' } {
  const s = stateOf(userId)
  while (s.starts.length && s.starts[0] <= now - WINDOW_MS) s.starts.shift()
  if (s.active >= FORMAT_MAX_CONCURRENT) return { ok: false, reason: 'concurrency' }
  if (s.starts.length >= FORMAT_MAX_PER_MINUTE) return { ok: false, reason: 'rate' }
  s.active++
  s.starts.push(now)
  return { ok: true }
}

export function releaseFormat(userId: string): void {
  const s = users.get(userId)
  if (s && s.active > 0) s.active--
}

/** Run `work` once for every identical in-flight request of the same user (`key`). */
export async function dedupeFormat<T>(
  key: string,
  work: () => Promise<T>
): Promise<{ value: T; shared: boolean }> {
  const existing = inflight.get(key) as Promise<T> | undefined
  if (existing) return { value: await existing, shared: true }
  const p = work()
  inflight.set(key, p)
  try {
    return { value: await p, shared: false }
  } finally {
    inflight.delete(key)
  }
}

/** For tests. */
export function resetFormatGuard(): void {
  users.clear()
  inflight.clear()
}
