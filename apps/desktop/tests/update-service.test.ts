import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSettings, type Settings } from '../src/shared/settings'
import type { InstallKind, UpdateStatus } from '../src/shared/updates'
import type { GithubRelease } from '../src/core/update/releases'
import { UpdateService, type UpdateServiceDeps } from '../src/main/update/service'
import { ChecksumMismatchError, downloadFile } from '../src/main/update/download'
import type { SettingsStore } from '../src/main/store/settings'

const ORIGIN = 'http://127.0.0.1:9'
const REPO = 'Owner/Repo'
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Just enough of SettingsStore for the updater: get/patch/on/off with the real schema. */
class FakeSettings extends EventEmitter {
  private data: Settings
  constructor(patch: Record<string, unknown> = {}) {
    super()
    this.data = parseSettings(patch)
  }
  get(): Settings {
    return this.data
  }
  patch(patch: Record<string, unknown>): Settings {
    const merged = JSON.parse(JSON.stringify(this.data)) as Record<string, unknown>
    for (const [section, value] of Object.entries(patch)) {
      merged[section] = { ...(merged[section] as object), ...(value as object) }
    }
    this.data = parseSettings(merged)
    this.emit('change', this.data, patch, 'local')
    return this.data
  }
  flush(): void {
    // in-memory only
  }
}

interface FakeAsset {
  name: string
  body: Buffer
  /** Serve a different body than the checksum describes. */
  corrupt?: boolean
}

/** In-memory stand-in for api.github.com + the release download host. */
class FakeGitHub {
  releases: Array<{ tag: string; prerelease?: boolean; draft?: boolean; assets: FakeAsset[] }> = []
  status = 200
  headers: Record<string, string> = {}
  requests: string[] = []
  withChecksums = true

  fetch = async (url: string): Promise<Response> => {
    this.requests.push(url)
    const u = new URL(url)
    if (u.pathname === `/repos/${REPO}/releases`) {
      if (this.status !== 200)
        return new Response('nope', { status: this.status, headers: this.headers })
      return Response.json(this.releases.map((r) => this.toGithub(r)))
    }
    const match = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(u.pathname)
    if (match) {
      const rel = this.releases.find((r) => r.tag === match[2])
      const name = decodeURIComponent(match[3])
      if (rel && name === 'SHA256SUMS.txt' && this.withChecksums) {
        return new Response(this.checksums(rel), { status: 200 })
      }
      const asset = rel?.assets.find((a) => a.name === name)
      if (asset) {
        // Same length, different bytes: only the digest can catch it.
        const body = asset.corrupt ? Buffer.from(asset.body.map((b) => b ^ 0xff)) : asset.body
        return new Response(new Uint8Array(body), {
          status: 200,
          headers: { 'content-length': String(body.byteLength) }
        })
      }
    }
    return new Response('not found', { status: 404 })
  }

  private toGithub(r: FakeGitHub['releases'][number]): GithubRelease {
    const base = `${ORIGIN}/${REPO}/releases/download/${r.tag}`
    const assets = r.assets.map((a) => ({
      name: a.name,
      size: a.body.byteLength,
      browser_download_url: `${base}/${a.name}`
    }))
    if (this.withChecksums) {
      assets.push({
        name: 'SHA256SUMS.txt',
        size: 1,
        browser_download_url: `${base}/SHA256SUMS.txt`
      })
    }
    return {
      tag_name: r.tag,
      name: `Murmur ${r.tag}`,
      draft: !!r.draft,
      prerelease: !!r.prerelease,
      published_at: '2026-09-01T10:00:00Z',
      html_url: `${ORIGIN}/${REPO}/releases/tag/${r.tag}`,
      body: 'notes',
      assets
    }
  }

  private checksums(r: FakeGitHub['releases'][number]): string {
    return r.assets
      .map((a) => `${createHash('sha256').update(a.body).digest('hex')}  ${a.name}`)
      .join('\n')
  }
}

function asset(name: string, content = `contents of ${name}`): FakeAsset {
  return { name, body: Buffer.from(content) }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('UpdateService', () => {
  let dir: string
  let gh: FakeGitHub
  let settings: FakeSettings
  let applied: Array<{ kind: InstallKind; file: string }>
  let quit: ReturnType<typeof vi.fn>
  let beforeInstall: ReturnType<typeof vi.fn>
  let idle = true
  let windowVisible = true

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-updates-'))
    gh = new FakeGitHub()
    gh.releases = [
      { tag: 'v0.1.0', assets: [asset('Murmur-0.1.0-x86_64.AppImage')] },
      {
        tag: 'v0.2.0',
        assets: [
          asset('Murmur-0.2.0-x86_64.AppImage'),
          asset('Murmur-0.2.0-arm64.AppImage'),
          asset('murmur_0.2.0_amd64.deb'),
          asset('Murmur-0.2.0-x64-setup.exe'),
          asset('Murmur-0.2.0-setup.exe'),
          asset('Murmur-0.2.0-portable.exe'),
          asset('Murmur-0.2.0-arm64.zip'),
          asset('Murmur-0.2.0-arm64.dmg')
        ]
      },
      {
        tag: 'v0.3.0-beta.1',
        prerelease: true,
        assets: [asset('Murmur-0.3.0-beta.1-x86_64.AppImage')]
      }
    ]
    settings = new FakeSettings()
    applied = []
    quit = vi.fn()
    beforeInstall = vi.fn()
    idle = true
    windowVisible = true
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function make(overrides: Partial<UpdateServiceDeps> = {}): UpdateService {
    return new UpdateService({
      settings: settings as unknown as SettingsStore,
      currentVersion: '0.1.0',
      platform: 'linux',
      arch: 'x64',
      installKind: 'appimage',
      source: { repo: REPO, apiBase: ORIGIN, downloadOrigin: ORIGIN },
      downloadDir: join(dir, 'updates'),
      stateFile: join(dir, 'updater.json'),
      fetch: gh.fetch,
      apply: async (kind, file) => {
        applied.push({ kind, file })
      },
      isIdle: () => idle,
      isMainWindowVisible: () => windowVisible,
      beforeInstall,
      quit,
      log: silent,
      autoInstallDelayMs: 10,
      initialDelayMs: 20,
      checkIntervalMs: 60_000,
      ...overrides
    })
  }

  function phases(service: UpdateService): string[] {
    const seen: string[] = []
    service.on('status', (s: UpdateStatus) => {
      if (seen[seen.length - 1] !== s.phase) seen.push(s.phase)
    })
    return seen
  }

  it('walks check -> download -> verify -> install and records the relaunch', async () => {
    settings.patch({ updates: { autoInstall: false } })
    const service = make()
    const seen = phases(service)
    expect(service.getStatus()).toMatchObject({
      phase: 'idle',
      canInstall: true,
      installKind: 'appimage'
    })

    const found = await service.check({ manual: true })
    expect(found.phase).toBe('available')
    expect(found.release).toMatchObject({
      version: '0.2.0',
      tag: 'v0.2.0',
      prerelease: false,
      asset: { name: 'Murmur-0.2.0-x86_64.AppImage' }
    })
    expect(found.release?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(found.canInstall).toBe(true)
    expect(found.lastCheckedAt).toBeGreaterThan(0)

    const ready = await service.download()
    expect(ready.phase).toBe('ready')
    expect(ready.downloadedPath).toBe(join(dir, 'updates', 'Murmur-0.2.0-x86_64.AppImage'))
    expect(readFileSync(ready.downloadedPath!, 'utf8')).toBe(
      'contents of Murmur-0.2.0-x86_64.AppImage'
    )
    expect(ready.waitingForIdle).toBe(false)

    windowVisible = false
    await service.install()
    expect(beforeInstall).toHaveBeenCalledTimes(1)
    expect(applied).toEqual([{ kind: 'appimage', file: ready.downloadedPath }])
    expect(quit).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['checking', 'available', 'downloading', 'ready', 'installing'])

    const persisted = JSON.parse(readFileSync(join(dir, 'updater.json'), 'utf8'))
    expect(persisted.pending).toEqual({ version: '0.2.0', from: '0.1.0', showWindow: false })

    // The relaunched app (now 0.2.0) sees the pending record, reports it once and clears it.
    const next = make({ currentVersion: '0.2.0' })
    expect(next.getStatus().updatedFrom).toBe('0.1.0')
    expect(next.shouldShowWindowAfterUpdate).toBe(false)
    expect(existsSync(ready.downloadedPath!)).toBe(false)
    next.ackUpdated()
    expect(next.getStatus().updatedFrom).toBeNull()
    expect(JSON.parse(readFileSync(join(dir, 'updater.json'), 'utf8')).pending).toBeNull()
  })

  it('downloads and installs on its own once dictation is idle when autoInstall is on', async () => {
    idle = false
    const service = make()
    await service.check({ manual: false })
    await vi.waitFor(() => expect(service.getStatus().phase).toBe('ready'))
    expect(service.getStatus().waitingForIdle).toBe(true)
    await sleep(40)
    expect(applied).toEqual([])

    idle = true
    service.notifyIdle()
    await vi.waitFor(() => expect(quit).toHaveBeenCalled())
    expect(applied[0]).toMatchObject({ kind: 'appimage' })
    expect(JSON.parse(readFileSync(join(dir, 'updater.json'), 'utf8')).pending.showWindow).toBe(
      true
    )
  })

  it('runs the scheduled check after the initial delay and honours autoCheck', async () => {
    const service = make({ initialDelayMs: 15 })
    settings.patch({ updates: { autoInstall: false } })
    service.start()
    await vi.waitFor(() => expect(service.getStatus().phase).toBe('available'))
    expect(gh.requests.some((u) => u.includes(`/repos/${REPO}/releases?`))).toBe(true)
    service.dispose()

    gh.requests = []
    settings.patch({ updates: { autoCheck: false } })
    const quiet = make({ initialDelayMs: 5 })
    quiet.start()
    await sleep(40)
    expect(gh.requests).toEqual([])
    quiet.dispose()
  })

  it('discards a download whose checksum does not match', async () => {
    settings.patch({ updates: { autoInstall: false } })
    gh.releases[1].assets[0].corrupt = true
    const service = make()
    await service.check({ manual: true })
    const result = await service.download()
    expect(result.phase).toBe('error')
    expect(result.error).toMatch(/did not match the release checksum/)
    expect(result.downloadedPath).toBeNull()
    expect(existsSync(join(dir, 'updates', 'Murmur-0.2.0-x86_64.AppImage'))).toBe(false)
    expect(existsSync(join(dir, 'updates', 'Murmur-0.2.0-x86_64.AppImage.part'))).toBe(false)
  })

  it('refuses to install when the release ships no checksums', async () => {
    settings.patch({ updates: { autoInstall: false } })
    gh.withChecksums = false
    const service = make()
    const found = await service.check({ manual: true })
    expect(found.release?.sha256).toBeNull()
    expect(found.canInstall).toBe(false)
    const ready = await service.download()
    expect(ready.phase).toBe('ready')
    await service.install()
    expect(applied).toEqual([])
    expect(service.getStatus().error).toMatch(/cannot update itself/)
  })

  it('only downloads for installs that cannot replace themselves', async () => {
    const service = make({ installKind: 'portable', platform: 'win32' })
    expect(service.getStatus().canInstall).toBe(false)
    await service.check({ manual: false })
    await vi.waitFor(() => expect(service.getStatus().phase).toBe('ready'))
    const s = service.getStatus()
    expect(s.release?.asset?.name).toBe('Murmur-0.2.0-portable.exe')
    expect(s.canInstall).toBe(false)
    expect(s.waitingForIdle).toBe(false)
    await sleep(30)
    expect(applied).toEqual([])
    expect(quit).not.toHaveBeenCalled()
  })

  it('picks the right file per install kind and architecture', async () => {
    settings.patch({ updates: { autoInstall: false } })
    const cases: Array<[InstallKind, NodeJS.Platform, string, string]> = [
      ['nsis', 'win32', 'x64', 'Murmur-0.2.0-x64-setup.exe'],
      ['nsis', 'win32', 'arm64', 'Murmur-0.2.0-setup.exe'],
      ['deb', 'linux', 'x64', 'murmur_0.2.0_amd64.deb'],
      ['appimage', 'linux', 'arm64', 'Murmur-0.2.0-arm64.AppImage'],
      ['mac', 'darwin', 'arm64', 'Murmur-0.2.0-arm64.zip'],
      ['dev', 'darwin', 'arm64', 'Murmur-0.2.0-arm64.dmg']
    ]
    for (const [kind, platform, arch, expected] of cases) {
      const service = make({ installKind: kind, platform, arch })
      const s = await service.check({ manual: true })
      expect(s.release?.asset?.name, `${kind}/${arch}`).toBe(expected)
      expect(s.canInstall, `${kind}/${arch}`).toBe(kind !== 'dev')
    }
    const noBuild = make({ installKind: 'mac', platform: 'darwin', arch: 'x64' })
    const s = await noBuild.check({ manual: true })
    expect(s.phase).toBe('available')
    expect(s.release?.asset).toBeNull()
    expect(s.canInstall).toBe(false)
  })

  it('skips a version for background checks but lists it again on a manual check', async () => {
    settings.patch({ updates: { autoInstall: false } })
    const service = make()
    await service.check({ manual: true })
    await service.download()
    const skipped = service.skip()
    expect(skipped.phase).toBe('up-to-date')
    expect(settings.get().updates.skippedVersion).toBe('0.2.0')
    expect(existsSync(join(dir, 'updates', 'Murmur-0.2.0-x86_64.AppImage'))).toBe(false)

    expect((await service.check({ manual: false })).phase).toBe('up-to-date')
    expect((await service.check({ manual: true })).release?.version).toBe('0.2.0')

    gh.releases.push({ tag: 'v0.2.1', assets: [asset('Murmur-0.2.1-x86_64.AppImage')] })
    expect((await service.check({ manual: false })).release?.version).toBe('0.2.1')
  })

  it('follows the pre-release preference and re-checks when it changes', async () => {
    settings.patch({ updates: { autoInstall: false } })
    const service = make()
    service.start()
    expect((await service.check({ manual: true })).release?.version).toBe('0.2.0')
    settings.patch({ updates: { includePrereleases: true } })
    await vi.waitFor(() => expect(service.getStatus().release?.version).toBe('0.3.0-beta.1'))
    expect(service.getStatus().release?.prerelease).toBe(true)
    service.dispose()
  })

  it('reports rate limits, missing repositories and network failures readably', async () => {
    settings.patch({ updates: { autoInstall: false } })
    gh.status = 403
    gh.headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }
    const service = make()
    expect((await service.check({ manual: true })).error).toMatch(/rate limit/)

    gh.status = 404
    gh.headers = {}
    expect((await service.check({ manual: true })).error).toMatch(/Owner\/Repo.*public/)

    const offline = make({
      fetch: async () => {
        throw new TypeError('fetch failed')
      }
    })
    const s = await offline.check({ manual: true })
    expect(s.phase).toBe('error')
    expect(s.error).toMatch(/Could not reach GitHub/)
  })

  it('keeps a verified download when a later check fails or finds the same release', async () => {
    settings.patch({ updates: { autoInstall: false } })
    const service = make()
    await service.check({ manual: true })
    const ready = await service.download()
    expect(ready.phase).toBe('ready')

    gh.status = 500
    const failed = await service.check({ manual: false })
    expect(failed.phase).toBe('ready')
    expect(failed.error).toMatch(/HTTP 500/)
    expect(existsSync(ready.downloadedPath!)).toBe(true)

    gh.status = 200
    const again = await service.check({ manual: false })
    expect(again.phase).toBe('ready')
    expect(again.downloadedPath).toBe(ready.downloadedPath)
  })

  it('does not let a scheduled check interrupt a running download', async () => {
    settings.patch({ updates: { autoInstall: false } })
    let releaseBody: (() => void) | null = null
    const slowFetch = async (url: string): Promise<Response> => {
      const res = await gh.fetch(url)
      if (!url.endsWith('.AppImage')) return res
      const bytes = new Uint8Array(await res.arrayBuffer())
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 10))
          releaseBody = () => {
            controller.enqueue(bytes.slice(10))
            controller.close()
          }
        }
      })
      return new Response(stream, { status: 200, headers: res.headers })
    }
    const service = make({ fetch: slowFetch })
    await service.check({ manual: true })
    const downloading = service.download()
    await vi.waitFor(() => expect(releaseBody).not.toBeNull())
    expect(service.getStatus().phase).toBe('downloading')
    const listCalls = gh.requests.filter((u) => u.includes('/releases?')).length

    const during = await service.check({ manual: false })
    expect(during.phase).toBe('downloading')
    expect(gh.requests.filter((u) => u.includes('/releases?')).length).toBe(listCalls)

    releaseBody!()
    expect((await downloading).phase).toBe('ready')
    expect(existsSync(join(dir, 'updates', 'Murmur-0.2.0-x86_64.AppImage'))).toBe(true)
  })

  it('ignores assets served from another origin', async () => {
    settings.patch({ updates: { autoInstall: false } })
    const service = make({
      source: { repo: REPO, apiBase: ORIGIN, downloadOrigin: 'https://github.com' }
    })
    const s = await service.check({ manual: true })
    expect(s.phase).toBe('available')
    expect(s.release?.asset).toBeNull()
  })

  it('surfaces install failures and keeps the download for a retry', async () => {
    settings.patch({ updates: { autoInstall: false } })
    const service = make({
      apply: async () => {
        throw new Error('pkexec is not available')
      }
    })
    await service.check({ manual: true })
    await service.download()
    const s = await service.install()
    expect(s.phase).toBe('ready')
    expect(s.error).toMatch(/pkexec/)
    expect(quit).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(dir, 'updater.json'), 'utf8')).pending).toBeNull()
  })
})

describe('downloadFile', () => {
  it('streams with progress and verifies the digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'murmur-dl-'))
    try {
      const body = Buffer.alloc(300_000, 7)
      const sha = createHash('sha256').update(body).digest('hex')
      const fetch = async (): Promise<Response> =>
        new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } })
      const progress: number[] = []
      const dest = join(dir, 'file.bin')
      const result = await downloadFile('http://x/file.bin', {
        fetch,
        dest,
        expectedSize: body.length,
        expectedSha256: sha.toUpperCase(),
        onProgress: (p) => progress.push(p.percent),
        progressIntervalMs: 0
      })
      expect(result).toEqual({ sha256: sha, size: body.length })
      expect(readFileSync(dest).equals(body)).toBe(true)
      expect(progress[0]).toBe(0)
      expect(progress[progress.length - 1]).toBe(100)

      await expect(
        downloadFile('http://x/file.bin', { fetch, dest, expectedSha256: 'ab'.repeat(32) })
      ).rejects.toBeInstanceOf(ChecksumMismatchError)
      expect(existsSync(`${dest}.part`)).toBe(false)

      await expect(
        downloadFile('http://x/file.bin', { fetch, dest, expectedSize: 5, expectedSha256: null })
      ).rejects.toThrow(/expected 5/)

      writeFileSync(dest, 'stale')
      await downloadFile('http://x/file.bin', { fetch, dest, expectedSha256: null })
      expect(readFileSync(dest).length).toBe(body.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
