import type { Meter, Refusal } from '../../../packages/backend/convex/lib/entitlements'
import type { GatewayIdentity, InferenceKind } from '../../../packages/backend/convex/lib/inference'
import type { AccessState, Plan } from '../../../packages/backend/convex/lib/plans'
import {
  breakerAfterFailure,
  breakerOpenFor,
  retryAfterSeconds,
  type BreakerState
} from '../../../packages/backend/convex/lib/upstream'

/**
 * The Worker's per-isolate state. None of it needs to be exact across isolates: the grant is the
 * account's allowance as Convex judged it a minute or two ago, the breaker only spares a provider
 * that is down, and usage is reported in batches (a record lost with an evicted isolate is a
 * dictation that goes unmetered, never one that is billed twice).
 */

export type Grant =
  | {
      ok: true
      plan: Plan
      planState: AccessState
      stt: Refusal | null
      llm: Refusal | null
      format: { refusal: Refusal | null; paused: Meter | null }
    }
  | { ok: false; denied: 'private_testing' }

/**
 * How long a grant is fresh. Five minutes, not two: a dictation's pieces and the formatting that
 * follows them share one allowance check, and a limit the account crosses in that window is a few
 * requests, not a reason to call Convex once per piece. Cloudflare starts a new isolate often
 * enough that a per-isolate map alone followed the Worker request rate (Nov 19: 19,668 requests).
 */
export const GRANT_TTL_MS = 5 * 60_000
/**
 * Convex gets this long to answer /worker/grant. Oct 15 2026: a grant fetch with no deadline stalled
 * every request of one user in an isolate (they share the in-flight promise) until the phone gave
 * up at 45 s, which showed as dictations stuck on "Transcribing" for minutes.
 */
export const GRANT_TIMEOUT_MS = 3_000
/** A grant this old may still be used when Convex is slow or unreachable. */
export const GRANT_STALE_MS = 30 * 60_000
/** How long the first record of a batch waits for company (inside `waitUntil`'s 30 s). */
export const USAGE_FLUSH_MS = 20_000
export const USAGE_FLUSH_COUNT = 25

export interface UsageRecord {
  clerkId: string
  kind: InferenceKind
  seconds?: number
  tokens?: number
  words?: number
  at: number
}

export interface ConvexLink {
  siteUrl: string
  secret: string
  fetcher: typeof fetch
}

const grants = new Map<string, { at: number; grant: Grant }>()
const inflight = new Map<string, Promise<Grant>>()

/** A grant another isolate in this colo already paid Convex for. */
export interface GrantCache {
  get(subject: string): Promise<{ at: number; grant: Grant } | null>
  set(subject: string, entry: { at: number; grant: Grant }): Promise<void>
}

/**
 * Cloudflare's Cache API, shared by the isolates of one colo. Tests inject their own; the Worker
 * uses `caches.default`. Absent outside workerd (unit tests, node), and a cache miss is not fatal.
 */
let grantCache: GrantCache | null | undefined

export function setGrantCache(cache: GrantCache | null): void {
  grantCache = cache
}

function cacheRequest(subject: string): Request {
  return new Request(`https://murmur-grant-cache.internal/v1/${encodeURIComponent(subject)}`)
}

function defaultGrantCache(): GrantCache | null {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default
  if (!cache) return null
  return {
    async get(subject) {
      const res = await cache.match(cacheRequest(subject))
      if (!res) return null
      return (await res.json()) as { at: number; grant: Grant }
    },
    async set(subject, entry) {
      await cache.put(
        cacheRequest(subject),
        new Response(JSON.stringify(entry), {
          headers: { 'cache-control': `public, max-age=${Math.ceil(GRANT_TTL_MS / 1000)}` }
        })
      )
    }
  }
}

async function sharedGrant(subject: string): Promise<{ at: number; grant: Grant } | null> {
  const cache = grantCache === undefined ? defaultGrantCache() : grantCache
  if (!cache) return null
  try {
    return await cache.get(subject)
  } catch (err) {
    console.warn(`[worker] grant cache read failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

async function rememberGrant(subject: string, entry: { at: number; grant: Grant }): Promise<void> {
  const cache = grantCache === undefined ? defaultGrantCache() : grantCache
  if (!cache) return
  try {
    await cache.set(subject, entry)
  } catch (err) {
    console.warn(`[worker] grant cache write failed: ${err instanceof Error ? err.message : err}`)
  }
}
const breakers: Record<InferenceKind, BreakerState> = {
  stt: { failures: 0, openUntil: null },
  llm: { failures: 0, openUntil: null }
}
let usage: UsageRecord[] = []
let oldestUsageAt = 0

/** Test hook. */
export function resetState(): void {
  grants.clear()
  inflight.clear()
  breakers.stt = { failures: 0, openUntil: null }
  breakers.llm = { failures: 0, openUntil: null }
  usage = []
  oldestUsageAt = 0
}

async function post(link: ConvexLink, path: string, body: unknown, timeoutMs = 10_000): Promise<Response> {
  const fetcher = link.fetcher
  return await fetcher(`${link.siteUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${link.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** The account's allowance: fresh for GRANT_TTL_MS, one Convex call per account per window per colo. */
export async function grantFor(link: ConvexLink, identity: GatewayIdentity, now = Date.now()): Promise<Grant> {
  const cached = grants.get(identity.subject)
  if (cached && now - cached.at < GRANT_TTL_MS) return cached.grant
  const pending = inflight.get(identity.subject)
  if (pending) return await pending
  const request = (async () => {
    const shared = await sharedGrant(identity.subject)
    if (shared && now - shared.at < GRANT_TTL_MS) {
      grants.set(identity.subject, shared)
      return shared.grant
    }
    try {
      const res = await post(
        link,
        '/worker/grant',
        { clerkId: identity.subject, email: identity.email, emailVerified: identity.emailVerified },
        GRANT_TIMEOUT_MS
      )
      if (!res.ok) throw new Error(`Convex /worker/grant answered HTTP ${res.status}`)
      const grant = (await res.json()) as Grant
      const entry = { at: now, grant }
      grants.set(identity.subject, entry)
      await rememberGrant(identity.subject, entry)
      return grant
    } catch (err) {
      // Convex slow or down: the last allowance it gave (if recent enough and not a denial) stands.
      const stale = cached ?? shared
      if (stale && stale.grant.ok && now - stale.at < GRANT_STALE_MS) {
        console.warn(`[worker] grant refresh failed, using the cached grant: ${err instanceof Error ? err.message : err}`)
        grants.set(identity.subject, stale)
        return stale.grant
      }
      throw err
    }
  })()
  inflight.set(identity.subject, request)
  try {
    return await request
  } finally {
    inflight.delete(identity.subject)
  }
}

export function providerState(kind: InferenceKind, now = Date.now()): { failures: number; openForSec: number | null } {
  const openMs = breakerOpenFor(breakers[kind], now)
  return { failures: breakers[kind].failures, openForSec: openMs === null ? null : retryAfterSeconds(openMs) }
}

export function providerFailed(kind: InferenceKind, now = Date.now()): { failures: number; openForSec: number | null } {
  breakers[kind] = breakerAfterFailure(breakers[kind], now)
  return providerState(kind, now)
}

export function providerRecovered(kind: InferenceKind): void {
  breakers[kind] = { failures: 0, openUntil: null }
}

/**
 * Queue one request's usage. `now`: the buffer is full or old, send it; `later`: this record
 * started a batch, send it after USAGE_FLUSH_MS; `none`: a send is already scheduled.
 */
export function queueUsage(record: UsageRecord, now = Date.now()): 'now' | 'later' | 'none' {
  const first = usage.length === 0
  if (first) oldestUsageAt = now
  usage.push(record)
  if (usage.length >= USAGE_FLUSH_COUNT || now - oldestUsageAt >= USAGE_FLUSH_MS) return 'now'
  return first ? 'later' : 'none'
}

export function pendingUsage(): number {
  return usage.length
}

/**
 * Send the buffered usage to Convex in one call (inference.recordBatch). On failure the records go
 * back in front of the buffer (capped) for the next flush.
 */
export async function flushUsage(link: ConvexLink): Promise<void> {
  if (usage.length === 0) return
  const batch = usage.splice(0, 500)
  oldestUsageAt = usage.length ? Date.now() : 0
  try {
    const res = await post(link, '/worker/usage', { records: batch })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    console.warn(`[worker] usage report failed (${batch.length} records kept): ${err instanceof Error ? err.message : err}`)
    usage = [...batch, ...usage].slice(0, 2000)
    if (!oldestUsageAt) oldestUsageAt = Date.now()
  }
}
