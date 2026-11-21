import type { ConvexLink, UsageRecord } from './state'

export interface UsageKv {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>
}

const PREFIX = 'usage:'

/** Keep a failed usage batch until Convex accepts it. Keys expire after 40 days. */
export async function spillUsage(kv: UsageKv, records: UsageRecord[]): Promise<void> {
  if (records.length === 0) return
  const key = `${PREFIX}${Date.now()}-${crypto.randomUUID()}`
  await kv.put(key, JSON.stringify(records), { expirationTtl: 40 * 24 * 60 * 60 })
}

/** Send spilled batches back to Convex. Stops at the first failure so the rest stay. */
export async function replayUsage(kv: UsageKv, link: ConvexLink): Promise<number> {
  const listed = await kv.list({ prefix: PREFIX, limit: 20 })
  let sent = 0
  for (const item of listed.keys) {
    const raw = await kv.get(item.name)
    if (!raw) {
      await kv.delete(item.name)
      continue
    }
    let records: UsageRecord[]
    try {
      records = JSON.parse(raw) as UsageRecord[]
    } catch {
      await kv.delete(item.name)
      continue
    }
    const res = await link.fetcher(`${link.siteUrl.replace(/\/+$/, '')}/worker/usage`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${link.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ records })
    })
    if (!res.ok) break
    await kv.delete(item.name)
    sent += records.length
  }
  return sent
}
