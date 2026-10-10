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

export const GRANT_TTL_MS = 120_000
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

async function post(link: ConvexLink, path: string, body: unknown): Promise<Response> {
  return await link.fetcher(`${link.siteUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${link.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** The account's allowance: cached for GRANT_TTL_MS, one Convex call per account per window. */
export async function grantFor(link: ConvexLink, identity: GatewayIdentity, now = Date.now()): Promise<Grant> {
  const cached = grants.get(identity.subject)
  if (cached && now - cached.at < GRANT_TTL_MS) return cached.grant
  const pending = inflight.get(identity.subject)
  if (pending) return await pending
  const request = (async () => {
    const res = await post(link, '/worker/grant', {
      clerkId: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified
    })
    if (!res.ok) throw new Error(`Convex /worker/grant answered HTTP ${res.status}`)
    const grant = (await res.json()) as Grant
    grants.set(identity.subject, { at: now, grant })
    return grant
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
