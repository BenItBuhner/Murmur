import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET, dynamic, dynamicParams, generateStaticParams } from '../app/download/[platform]/route'
import { DOWNLOAD_PLATFORMS, stableDownloadUrl } from './releases'
import { releasesRepo } from './site'

/*
 * /download/<platform> is static output that redirects to GitHub's stable alias. These pin the
 * two things that made the previous version go stale after a release: a redirect target that
 * named a version, and a handler that had to revalidate to learn about a new one.
 */

const call = (platform: string): Promise<Response> =>
  GET(new Request(`https://murmur.test/download/${platform}`), {
    params: Promise.resolve({ platform })
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /download/[platform]', () => {
  it('redirects every download platform to its stable alias, never to a versioned file', async () => {
    const base = `https://github.com/${releasesRepo()}/releases/latest/download`
    const expected = {
      windows: `${base}/Murmur-setup.exe`,
      linux: `${base}/Murmur-x86_64.AppImage`,
      android: `${base}/Murmur-android.apk`
    }
    for (const platform of DOWNLOAD_PLATFORMS) {
      const res = await call(platform)
      expect(res.status, platform).toBe(302)
      expect(res.headers.get('location'), platform).toBe(expected[platform])
      expect(res.headers.get('location'), platform).toBe(stableDownloadUrl(platform))
      expect(res.headers.get('location'), platform).not.toMatch(/\/releases\/download\/v\d/)
    }
  })

  it('needs no network: the redirect is the same when GitHub is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('no network in this test')
      })
    )
    const res = await call('android')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(stableDownloadUrl('android'))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('answers 404 for anything but the three download platforms', async () => {
    for (const platform of ['macos', 'ios', 'Windows', '']) {
      const res = await call(platform)
      expect(res.status, platform).toBe(404)
    }
  })

  it('is prerendered once for exactly the download platforms', () => {
    expect(dynamic).toBe('force-static')
    expect(dynamicParams).toBe(false)
    expect(generateStaticParams().map((p) => p.platform)).toEqual([...DOWNLOAD_PLATFORMS])
  })
})
