import { describe, expect, it } from 'vitest'
import { handle, type Env } from '../src/index'

const KEY = 'k'.repeat(32)
const PUB = 'p'.repeat(32)

/** In-memory stand-in for the KV binding. */
function fakeKv() {
  const data = new Map<string, Uint8Array>()
  return {
    data,
    async get(k: string, type: 'json' | 'stream' | 'arrayBuffer' | 'text' = 'text') {
      const v = data.get(k)
      if (!v) return null
      if (type === 'json') return JSON.parse(new TextDecoder().decode(v))
      if (type === 'stream') return new Blob([v as BlobPart]).stream()
      if (type === 'arrayBuffer') return v.slice().buffer
      return new TextDecoder().decode(v)
    },
    async put(k: string, v: string | ArrayBuffer) {
      data.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v))
    }
  }
}

function setup() {
  const kv = fakeKv()
  kv.data.set('config:keys', new TextEncoder().encode('{"FEED_KEY":"secret"}'))
  const env = { FEED: kv, FEED_KEY: KEY, PUBLISH_KEY: PUB } as unknown as Env
  const req = (method: string, path: string, body?: BodyInit, auth = PUB) =>
    handle(
      new Request(`https://feed.example${path}`, {
        method,
        body,
        headers: auth ? { Authorization: `Bearer ${auth}` } : {}
      }),
      env
    )
  return { kv, req }
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
    expect((await req('GET', `/${KEY}/dl/config/keys`, undefined, '')).status).toBe(404)
    expect((await req('PUT', `/${KEY}/upload/config/keys?part=0`, 'x')).status).toBe(404)
    expect(
      (await req('GET', `/${KEY}/repos/BenItBuhner/Ephemeris/releases`, undefined, '')).status
    ).toBe(200)
  })

  it('refuses to seal a file with a missing chunk', async () => {
    const { req } = setup()
    const path = `/${KEY}/upload/v0.1.2/a.exe`
    await req('PUT', `${path}?part=0`, new Uint8Array([1]))
    expect((await req('POST', `${path}?complete&parts=2`)).status).toBe(409)
    expect((await req('GET', `/${KEY}/dl/v0.1.2/a.exe`, undefined, '')).status).toBe(404)
  })

  it('takes a chunked upload and serves it in the GitHub Releases shape', async () => {
    const { req } = setup()
    const path = `/${KEY}/upload/v0.1.2/Ephemeris-0.1.2-x64-setup.exe`
    expect((await req('PUT', `${path}?part=0`, new Uint8Array([1, 2]))).status).toBe(200)
    expect((await req('PUT', `${path}?part=1`, new Uint8Array([3]))).status).toBe(200)
    expect((await req('POST', `${path}?complete&parts=2`)).status).toBe(200)
    const manifest = [
      {
        tag_name: 'v0.1.2',
        published_at: '2026-11-16T00:00:00Z',
        assets: [{ name: 'Ephemeris-0.1.2-x64-setup.exe', size: 3, sha256: 'a'.repeat(64) }]
      }
    ]
    expect((await req('PUT', `/${KEY}/manifest`, JSON.stringify(manifest))).status).toBe(200)

    const res = await req(
      'GET',
      `/${KEY}/repos/BenItBuhner/Ephemeris/releases?per_page=30`,
      undefined,
      ''
    )
    const releases = await res.json()
    expect(releases[0]).toMatchObject({ tag_name: 'v0.1.2', draft: false, prerelease: false })
    const asset = releases[0].assets[0]
    expect(asset.digest).toBe(`sha256:${'a'.repeat(64)}`)
    expect(new URL(asset.browser_download_url).origin).toBe('https://feed.example')
    const got = await req('GET', new URL(asset.browser_download_url).pathname, undefined, '')
    expect(got.status).toBe(200)
    expect(got.headers.get('content-length')).toBe('3')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})
