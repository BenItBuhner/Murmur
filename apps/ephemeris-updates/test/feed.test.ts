import { describe, expect, it } from 'vitest'
import { handle, type Env } from '../src/index'

const KEY = 'k'.repeat(32)
const PUB = 'p'.repeat(32)

/** In-memory stand-in for the R2 binding, multipart included. */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>()
  const uploads = new Map<string, Map<number, Uint8Array>>()
  const obj = (key: string, data: Uint8Array) => ({
    key,
    size: data.length,
    body: new Blob([data as BlobPart]).stream(),
    json: async () => JSON.parse(new TextDecoder().decode(data))
  })
  return {
    objects,
    async get(k: string) {
      const d = objects.get(k)
      return d ? obj(k, d) : null
    },
    async put(k: string, v: string) {
      objects.set(k, new TextEncoder().encode(v))
    },
    async createMultipartUpload(k: string) {
      const id = `${k}#${uploads.size}`
      uploads.set(id, new Map())
      return { uploadId: id }
    },
    resumeMultipartUpload(k: string, id: string) {
      return {
        async uploadPart(n: number, body: ReadableStream) {
          uploads.get(id)!.set(n, new Uint8Array(await new Response(body).arrayBuffer()))
          return { partNumber: n, etag: `e${n}` }
        },
        async complete(parts: { partNumber: number }[]) {
          const p = uploads.get(id)!
          const chunks = parts.map((x) => p.get(x.partNumber)!)
          const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
          let o = 0
          for (const c of chunks) all.set(c, (o += c.length) - c.length)
          objects.set(k, all)
          return { key: k, size: all.length }
        }
      }
    }
  }
}

function setup() {
  const bucket = fakeBucket()
  const env = { FEED: bucket, FEED_KEY: KEY, PUBLISH_KEY: PUB } as unknown as Env
  const req = (method: string, path: string, body?: BodyInit, auth = PUB) =>
    handle(
      new Request(`https://feed.example${path}`, {
        method,
        body,
        headers: auth ? { Authorization: `Bearer ${auth}` } : {}
      }),
      env
    )
  return { bucket, req }
}

describe('Ephemeris update feed', () => {
  it('is a 404 without the key, and publishing needs the publish key too', async () => {
    const { req } = setup()
    expect((await req('GET', '/repos/BenItBuhner/Ephemeris/releases')).status).toBe(404)
    expect(
      (await req('GET', `/${'x'.repeat(32)}/repos/BenItBuhner/Ephemeris/releases`)).status
    ).toBe(404)
    expect((await req('PUT', `/${KEY}/manifest`, '[]', 'wrong'.repeat(8))).status).toBe(404)
    expect((await req('PUT', `/${KEY}/manifest`, '[]', '')).status).toBe(404)
    expect((await req('GET', `/${KEY}/dl/config/keys.json`, undefined, '')).status).toBe(404)
    expect((await req('POST', `/${KEY}/upload/config/keys.json?start`)).status).toBe(404)
    expect(
      (await req('GET', `/${KEY}/repos/BenItBuhner/Ephemeris/releases`, undefined, '')).status
    ).toBe(200)
  })

  it('takes a multipart upload and serves it in the GitHub Releases shape', async () => {
    const { req } = setup()
    const path = `/${KEY}/upload/v0.1.2/Ephemeris-0.1.2-x64-setup.exe`
    const { uploadId } = await (await req('POST', `${path}?start`)).json()
    const id = encodeURIComponent(uploadId)
    const p1 = await (
      await req('PUT', `${path}?uploadId=${id}&part=1`, new Uint8Array([1, 2]))
    ).json()
    const p2 = await (await req('PUT', `${path}?uploadId=${id}&part=2`, new Uint8Array([3]))).json()
    expect(
      (await req('POST', `${path}?uploadId=${id}&complete`, JSON.stringify([p1, p2]))).status
    ).toBe(200)
    const manifest = [
      {
        tag_name: 'v0.1.2',
        published_at: '2026-11-16T00:00:00Z',
        assets: [{ name: 'Ephemeris-0.1.2-x64-setup.exe', size: 3, sha256: 'a'.repeat(64) }]
      }
    ]
    expect((await req('PUT', `/${KEY}/manifest`, JSON.stringify(manifest))).status).toBe(200)

    const releases = await (
      await req('GET', `/${KEY}/repos/BenItBuhner/Ephemeris/releases?per_page=30`, undefined, '')
    ).json()
    expect(releases[0]).toMatchObject({ tag_name: 'v0.1.2', draft: false, prerelease: false })
    const asset = releases[0].assets[0]
    expect(asset.digest).toBe(`sha256:${'a'.repeat(64)}`)
    expect(new URL(asset.browser_download_url).origin).toBe('https://feed.example')
    const got = await req('GET', new URL(asset.browser_download_url).pathname, undefined, '')
    expect(got.status).toBe(200)
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})
