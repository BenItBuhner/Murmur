import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BINDING_NAME as KV_BINDING } from '@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import nextConfig from '../../next.config'
import openNextConfig from '../../open-next.config'

/*
 * The Cloudflare Worker is described in three places that have to agree: wrangler.jsonc (the
 * bindings), open-next.config.ts (which adapter overrides use them) and public/_headers (the
 * headers static assets get instead of next.config's). These tests keep them in step and pin the
 * choices that keep the site on the Workers Free plan.
 */

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (path: string) => readFileSync(new URL(path, `file://${root}`), 'utf8')

interface WranglerConfig {
  name: string
  main: string
  compatibility_date: string
  compatibility_flags: string[]
  minify?: boolean
  assets: { directory: string; binding: string }
  services: Array<{ binding: string; service: string }>
  kv_namespaces: Array<{ binding: string; id?: string }>
  durable_objects: { bindings: Array<{ name: string; class_name: string }> }
  migrations: Array<{ tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }>
  r2_buckets?: unknown[]
  d1_databases?: unknown[]
}

function readWranglerConfig(): WranglerConfig {
  // wrangler.jsonc carries comments; TypeScript's config reader parses JSONC.
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', read('wrangler.jsonc'))
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  return config as WranglerConfig
}

/** Resolve an override the way the adapter does: a string name, a value, or a factory for one. */
async function overrideName(value: unknown): Promise<string> {
  if (typeof value === 'string') return value
  const resolved = typeof value === 'function' ? await value() : value
  return (resolved as { name: string }).name
}

describe('wrangler.jsonc', () => {
  const config = readWranglerConfig()

  it('names the Worker and points at the adapter output', () => {
    expect(config.name).toBe('murmur-web')
    expect(config.main).toBe('.open-next/worker.js')
    expect(config.assets).toEqual({ directory: '.open-next/assets', binding: 'ASSETS' })
  })

  it('meets the adapter requirements and stays under the Free plan size limit', () => {
    expect(config.compatibility_flags).toContain('nodejs_compat')
    expect(config.compatibility_date >= '2024-09-23').toBe(true)
    expect(config.minify).toBe(true)
  })

  it('binds the caches the OpenNext config uses, on Free-plan storage only', () => {
    expect(config.services).toContainEqual({
      binding: 'WORKER_SELF_REFERENCE',
      service: config.name
    })
    expect(config.kv_namespaces.map((ns) => ns.binding)).toEqual([KV_BINDING])
    expect(config.durable_objects.bindings).toEqual([
      { name: 'NEXT_CACHE_DO_QUEUE', class_name: 'DOQueueHandler' }
    ])
    // Only SQLite-backed Durable Objects exist on the Free plan.
    expect(config.migrations.flatMap((m) => m.new_sqlite_classes ?? [])).toContain('DOQueueHandler')
    expect(config.migrations.flatMap((m) => m.new_classes ?? [])).toEqual([])
    // R2 needs a card on file and D1 is only for on-demand revalidation, which the site does not use.
    expect(config.r2_buckets ?? []).toEqual([])
    expect(config.d1_databases ?? []).toEqual([])
  })
})

describe('open-next.config.ts', () => {
  it('uses the KV incremental cache and the Durable Object queue, no tag cache', async () => {
    const override = openNextConfig.default?.override ?? {}
    expect(await overrideName(override.incrementalCache)).toBe('cf-kv-incremental-cache')
    expect(await overrideName(override.queue)).toBe('durable-queue')
    expect(await overrideName(override.tagCache)).toBe('dummy')
  })
})

describe('public/_headers', () => {
  const text = read('public/_headers')
  const blocks = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!line.startsWith(' ')) {
      current = []
      blocks.set(line.trim(), current)
    } else {
      current?.push(line.trim())
    }
  }

  it('gives static assets the same security headers next.config.ts gives pages', async () => {
    const rules = await nextConfig.headers!()
    const siteWide = rules.find((rule) => rule.source === '/:path*')
    expect(siteWide).toBeDefined()
    const expected = siteWide!.headers.map((h) => `${h.key}: ${h.value}`)
    expect(blocks.get('/*')).toEqual(expected)
  })

  it('marks the hashed build files immutable', () => {
    expect(blocks.get('/_next/static/*')).toEqual([
      'Cache-Control: public, max-age=31536000, immutable'
    ])
  })
})
