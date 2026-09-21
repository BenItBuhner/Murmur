import { defineCloudflareConfig } from '@opennextjs/cloudflare'
import kvIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache'
import doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue'

/**
 * How the site's caching maps onto Cloudflare, all of it on the Workers Free plan.
 *
 * Incremental cache: Workers KV. The download page, /api/releases/latest and the GitHub fetch
 * behind them revalidate every ten minutes, and a revalidation has to write the fresh copy
 * somewhere every location can read it. The adapter's static-assets cache is read-only (the site
 * would show the release it was built with until the next deploy, and a release does not deploy
 * the site), and its Cache API layer only sits in front of KV or R2. Of the two writable stores KV
 * is the one with a free tier that needs no card: 100,000 reads and 1,000 writes a day, of which
 * this site uses a few hundred writes (two routes revalidating six times an hour plus one deploy).
 * KV is eventually consistent, which for "which release is current" is immaterial.
 *
 * Queue: a SQLite-backed Durable Object that deduplicates revalidations, so a burst of visitors
 * after the ten minutes triggers one render, not one per request. Durable Objects with SQLite
 * storage are on the Free plan.
 *
 * No tag cache: nothing calls revalidateTag or revalidatePath.
 */
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  queue: doQueue
})
