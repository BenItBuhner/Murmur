/**
 * Ephemeris update feed (Workers Free + Workers KV). Serves, under /<FEED_KEY>/:
 *   GET repos/<owner>/<name>/releases  the GitHub Releases API shape the desktop updater reads,
 *                                      built from the `releases` manifest
 *   GET dl/<tag>/<file>                a release asset, streamed from its KV chunks
 * and, with `Authorization: Bearer <PUBLISH_KEY>` as well, the publishing side (scripts/publish.mjs):
 *   PUT  upload/<tag>/<file>?part=<n>          one chunk, n from 0 (at most 24 MiB: KV's 25 MiB cap)
 *   POST upload/<tag>/<file>?complete&parts=<k> seal the file once its k chunks are in
 *   PUT  manifest                               body: the releases list
 * Anything else, and any request without the key, is a 404 (the feed does not admit it exists).
 * KV keys: `releases`, `meta:<tag>/<file>`, `chunk:<tag>/<file>:<n>`; `config:*` (the deploy's own
 * copy of the keys) is never read or written here.
 */

export interface Env {
  FEED: KVNamespace
  FEED_KEY: string
  PUBLISH_KEY: string
}

/** One entry of the manifest, as scripts/publish.mjs writes it. */
interface ManifestRelease {
  tag_name: string
  name?: string
  body?: string
  published_at: string
  prerelease?: boolean
  html_url?: string
  assets: { name: string; size: number; sha256: string }[]
}

interface AssetMeta {
  parts: number
  size: number
}

export const MAX_CHUNK = 24 * 1024 * 1024

const notFound = (): Response => new Response('Not found', { status: 404 })

/** Constant-time comparison so the key cannot be found a byte at a time. */
function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

const FILE = /^[A-Za-z0-9._-]+$/
const TAG = /^v\d+\.\d+\.\d+[A-Za-z0-9.-]*$/

export async function handle(
  request: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>
): Promise<Response> {
  const url = new URL(request.url)
  const [key, ...rest] = url.pathname.split('/').filter(Boolean)
  if (!env.FEED_KEY || env.FEED_KEY.length < 24 || !key || !sameKey(key, env.FEED_KEY)) {
    return notFound()
  }
  const base = `${url.origin}/${key}`

  if (request.method === 'POST' || request.method === 'PUT') {
    const auth = request.headers.get('authorization') ?? ''
    if (
      !env.PUBLISH_KEY ||
      env.PUBLISH_KEY.length < 24 ||
      !sameKey(auth, `Bearer ${env.PUBLISH_KEY}`)
    ) {
      return notFound()
    }
    return publish(request, env, url, rest)
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound()

  if (rest.length === 4 && rest[0] === 'repos' && rest[3] === 'releases') {
    const manifest = (await env.FEED.get<ManifestRelease[]>('releases', 'json')) ?? []
    const releases = manifest.map((r, i) => ({
      id: i + 1,
      tag_name: r.tag_name,
      name: r.name ?? r.tag_name,
      body: r.body ?? '',
      draft: false,
      prerelease: !!r.prerelease,
      published_at: r.published_at,
      html_url: r.html_url ?? `https://github.com/${rest[1]}/${rest[2]}/releases`,
      assets: r.assets.map((a) => ({
        name: a.name,
        size: a.size,
        digest: `sha256:${a.sha256}`,
        browser_download_url: `${base}/dl/${encodeURIComponent(r.tag_name)}/${encodeURIComponent(a.name)}`
      }))
    }))
    return Response.json(releases, { headers: { 'Cache-Control': 'no-store' } })
  }

  if (rest.length === 3 && rest[0] === 'dl' && TAG.test(rest[1]) && FILE.test(rest[2])) {
    const id = `${rest[1]}/${rest[2]}`
    const meta = await env.FEED.get<AssetMeta>(`meta:${id}`, 'json')
    if (!meta) return notFound()
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(meta.size),
      'Content-Disposition': `attachment; filename="${rest[2]}"`,
      'Cache-Control': 'private, no-store'
    }
    if (request.method === 'HEAD') return new Response(null, { headers })
    // FixedLengthStream lets the runtime send Content-Length; plain streams elsewhere (tests).
    const { readable, writable } =
      typeof FixedLengthStream === 'function'
        ? new FixedLengthStream(meta.size)
        : new TransformStream<Uint8Array, Uint8Array>()
    const pump = async (): Promise<void> => {
      for (let n = 0; n < meta.parts; n++) {
        const chunk = await env.FEED.get(`chunk:${id}:${n}`, 'stream')
        if (!chunk) throw new Error(`missing chunk ${n} of ${id}`)
        await chunk.pipeTo(writable, { preventClose: n < meta.parts - 1 })
      }
    }
    const pumping = pump().catch((err) => writable.abort(err))
    ctx?.waitUntil(pumping)
    return new Response(readable, { headers })
  }
  return notFound()
}

async function publish(request: Request, env: Env, url: URL, rest: string[]): Promise<Response> {
  if (request.method === 'PUT' && rest.length === 1 && rest[0] === 'manifest') {
    const manifest = (await request.json()) as ManifestRelease[]
    if (!Array.isArray(manifest)) return new Response('manifest must be an array', { status: 400 })
    await env.FEED.put('releases', JSON.stringify(manifest))
    return Response.json({ ok: true, releases: manifest.length })
  }
  if (rest.length !== 3 || rest[0] !== 'upload' || !TAG.test(rest[1]) || !FILE.test(rest[2])) {
    return notFound()
  }
  const id = `${rest[1]}/${rest[2]}`
  const q = url.searchParams
  if (request.method === 'PUT' && q.has('part')) {
    const n = Number(q.get('part'))
    if (!Number.isInteger(n) || n < 0 || n > 64) return new Response('bad part', { status: 400 })
    const body = await request.arrayBuffer()
    if (body.byteLength === 0 || body.byteLength > MAX_CHUNK) {
      return new Response(`a part is 1 byte to ${MAX_CHUNK} bytes`, { status: 413 })
    }
    await env.FEED.put(`chunk:${id}:${n}`, body)
    return Response.json({ part: n, size: body.byteLength })
  }
  if (request.method === 'POST' && q.has('complete')) {
    const parts = Number(q.get('parts'))
    if (!Number.isInteger(parts) || parts < 1 || parts > 65) {
      return new Response('bad parts', { status: 400 })
    }
    let size = 0
    for (let n = 0; n < parts; n++) {
      const chunk = await env.FEED.get(`chunk:${id}:${n}`, 'arrayBuffer')
      if (!chunk) return new Response(`part ${n} is missing`, { status: 409 })
      size += chunk.byteLength
    }
    await env.FEED.put(`meta:${id}`, JSON.stringify({ parts, size } satisfies AssetMeta))
    return Response.json({ id, parts, size })
  }
  return new Response('bad request', { status: 400 })
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx)
} satisfies ExportedHandler<Env>
