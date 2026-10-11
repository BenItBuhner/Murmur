import type { InferenceKind } from './inference'

/**
 * The shared-secret check for the inference Worker's calls into Convex (/worker/*): null when the
 * request carries `Authorization: Bearer <MURMUR_WORKER_SECRET>`, otherwise the response to send.
 * Compared in constant time; an unset or short secret refuses everything.
 */
export function workerAuthorized(request: Request, secret: string | undefined): Response | null {
  if (!secret || secret.length < 32) return new Response('Worker access not configured', { status: 503 })
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return constantTimeEqual(token, secret) ? null : new Response('Unauthorized', { status: 401 })
}

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export interface UsageRecord {
  clerkId: string
  kind: InferenceKind
  seconds?: number
  tokens?: number
  words?: number
  at: number
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** Validate a Worker usage report; null when it is not one. At most 500 records. */
export function parseUsageRecords(raw: unknown): UsageRecord[] | null {
  if (!Array.isArray(raw) || raw.length > 500) return null
  const out: UsageRecord[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const r = item as Record<string, unknown>
    if (typeof r.clerkId !== 'string' || !r.clerkId) return null
    if (r.kind !== 'stt' && r.kind !== 'llm') return null
    const at = num(r.at)
    if (at === undefined) return null
    out.push({ clerkId: r.clerkId, kind: r.kind, seconds: num(r.seconds), tokens: num(r.tokens), words: num(r.words), at })
  }
  return out
}
