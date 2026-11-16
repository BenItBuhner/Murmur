/**
 * Ephemeris update feed. Serves, under /<FEED_KEY>/:
 *   GET repos/<owner>/<name>/releases  the GitHub Releases API shape the desktop updater reads,
 *                                      built from releases.json in the bucket
 *   GET dl/<tag>/<file>                a release asset, streamed from the bucket
 * and, with `Authorization: Bearer <PUBLISH_KEY>` as well, the publishing side (scripts/publish.mjs):
 *   POST upload/<tag>/<file>?start                    begin a multipart upload -> { uploadId }
 *   PUT  upload/<tag>/<file>?uploadId=..&part=<n>     one part (under the 100 MB request limit)
 *   POST upload/<tag>/<file>?uploadId=..&complete     body: [{ partNumber, etag }]
 *   PUT  manifest                                     body: releases.json
 * Anything else, and any request without the key, is a 404 (the feed does not admit it exists).
 */

export interface Env {
  FEED: R2Bucket
  FEED_KEY: string
  PUBLISH_KEY: string
}

/** One entry of releases.json, as scripts/publish.mjs writes it. */
interface ManifestRelease {
  tag_name: string
  name?: string
  body?: string
  published_at: string
  prerelease?: boolean
  html_url?: string
  assets: { name: string; size: number; sha256: string }[]
}

const notFound = (): Response => new Response('Not found', { status: 404 })

/** Constant-time comparison so the key cannot be found a byte at a time. */
function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

const SAFE = /^[A-Za-z0-9._-]+$/
/** Release folders only: never config/ (the keys) or anything else in the bucket. */
const TAG = /^v\d+\.\d+\.\d+[A-Za-z0-9.-]*$/

export async function handle(request: Request, env: Env): Promise<Response> {
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
    const obj = await env.FEED.get('releases.json')
    const manifest = obj ? ((await obj.json()) as ManifestRelease[]) : []
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

  if (rest.length === 3 && rest[0] === 'dl' && TAG.test(rest[1]) && SAFE.test(rest[2])) {
    const obj = await env.FEED.get(`${rest[1]}/${rest[2]}`)
    if (!obj) return notFound()
    return new Response(request.method === 'HEAD' ? null : obj.body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(obj.size),
        'Content-Disposition': `attachment; filename="${rest[2]}"`,
        'Cache-Control': 'private, no-store'
      }
    })
  }
  return notFound()
}

async function publish(request: Request, env: Env, url: URL, rest: string[]): Promise<Response> {
  if (request.method === 'PUT' && rest.length === 1 && rest[0] === 'manifest') {
    const manifest = (await request.json()) as ManifestRelease[]
    if (!Array.isArray(manifest)) return new Response('manifest must be an array', { status: 400 })
    await env.FEED.put('releases.json', JSON.stringify(manifest), {
      httpMetadata: { contentType: 'application/json' }
    })
    return Response.json({ ok: true, releases: manifest.length })
  }
  if (rest.length !== 3 || rest[0] !== 'upload' || !TAG.test(rest[1]) || !SAFE.test(rest[2])) {
    return notFound()
  }
  const objectKey = `${rest[1]}/${rest[2]}`
  const q = url.searchParams
  if (request.method === 'POST' && q.has('start')) {
    const upload = await env.FEED.createMultipartUpload(objectKey)
    return Response.json({ uploadId: upload.uploadId })
  }
  const uploadId = q.get('uploadId')
  if (!uploadId) return new Response('uploadId required', { status: 400 })
  const upload = env.FEED.resumeMultipartUpload(objectKey, uploadId)
  if (request.method === 'PUT' && q.has('part') && request.body) {
    const part = await upload.uploadPart(Number(q.get('part')), request.body)
    return Response.json(part)
  }
  if (request.method === 'POST' && q.has('complete')) {
    const parts = (await request.json()) as R2UploadedPart[]
    const obj = await upload.complete(parts)
    return Response.json({ key: obj.key, size: obj.size })
  }
  return new Response('bad request', { status: 400 })
}

export default { fetch: handle } satisfies ExportedHandler<Env>
