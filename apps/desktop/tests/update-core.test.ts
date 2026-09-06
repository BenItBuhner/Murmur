import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isPrerelease,
  normalizeVersion,
  parseVersion
} from '../src/core/update/version'
import {
  assetCandidates,
  describeRelease,
  isTrustedAssetUrl,
  parseChecksums,
  pickAsset,
  selectRelease,
  toUpdateArch,
  type GithubRelease
} from '../src/core/update/releases'
import { detectInstallKind } from '../src/main/update/install-kind'
import { repoFromUrl, resolveUpdateSource } from '../src/main/update/source'
// The release tooling is the source of truth for artifact names; the updater must agree with it.
import { ASSETS } from '../../../scripts/release.mjs'

function release(tag: string, extra: Partial<GithubRelease> = {}): GithubRelease {
  return {
    tag_name: tag,
    name: `Murmur ${tag}`,
    draft: false,
    prerelease: tag.includes('-'),
    published_at: '2026-09-01T10:00:00Z',
    html_url: `https://github.com/BenItBuhner/voxflow/releases/tag/${tag}`,
    body: 'notes',
    assets: [],
    ...extra
  }
}

describe('semver', () => {
  it('parses tags with and without the v prefix', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('0.2.0-beta.4')).toEqual({
      major: 0,
      minor: 2,
      patch: 0,
      prerelease: ['beta', '4']
    })
    expect(parseVersion('1.0.0+build.7')?.prerelease).toEqual([])
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('01.2.3')).toBeNull()
  })

  it('orders versions by semver precedence', () => {
    const sorted = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0'
    ]
    for (let i = 1; i < sorted.length; i++) {
      expect(compareVersions(sorted[i - 1], sorted[i])).toBeLessThan(0)
      expect(compareVersions(sorted[i], sorted[i - 1])).toBeGreaterThan(0)
    }
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('garbage', '0.1.0')).toBeLessThan(0)
  })

  it('knows pre-releases and strips the prefix', () => {
    expect(isPrerelease('0.2.0-beta.1')).toBe(true)
    expect(isPrerelease('0.2.0')).toBe(false)
    expect(normalizeVersion(' v0.2.0 ')).toBe('0.2.0')
  })
})

describe('selectRelease', () => {
  const feed = [
    release('v0.3.0-beta.1'),
    release('v0.2.1'),
    release('v0.2.0'),
    release('v0.1.0'),
    release('v9.9.9', { draft: true }),
    release('nightly')
  ]

  it('picks the newest stable release newer than the running version', () => {
    expect(
      selectRelease(feed, { currentVersion: '0.1.0', includePrereleases: false })?.tag_name
    ).toBe('v0.2.1')
  })

  it('returns null when already current, and never offers drafts or bad tags', () => {
    expect(selectRelease(feed, { currentVersion: '0.2.1', includePrereleases: false })).toBeNull()
    expect(selectRelease(feed, { currentVersion: '5.0.0', includePrereleases: true })).toBeNull()
  })

  it('offers pre-releases when opted in or when running one', () => {
    expect(
      selectRelease(feed, { currentVersion: '0.1.0', includePrereleases: true })?.tag_name
    ).toBe('v0.3.0-beta.1')
    expect(
      selectRelease(feed, { currentVersion: '0.2.1-beta.3', includePrereleases: false })?.tag_name
    ).toBe('v0.3.0-beta.1')
    // A stable release replaces the pre-release line the user is on.
    expect(
      selectRelease([release('v0.2.1')], {
        currentVersion: '0.2.1-beta.3',
        includePrereleases: false
      })?.tag_name
    ).toBe('v0.2.1')
  })

  it('withholds a skipped version until something newer appears', () => {
    const opts = { currentVersion: '0.1.0', includePrereleases: false, skippedVersion: '0.2.1' }
    expect(selectRelease(feed, opts)).toBeNull()
    expect(selectRelease([release('v0.2.2'), ...feed], opts)?.tag_name).toBe('v0.2.2')
  })
})

describe('asset selection', () => {
  const version = '0.2.0'
  const known = new Set<string>(ASSETS.map((a: { file: (v: string) => string }) => a.file(version)))

  it('only ever asks for files the release workflow publishes', () => {
    const kinds = ['nsis', 'portable', 'appimage', 'deb', 'mac', 'dev', 'unknown'] as const
    const platforms = ['win32', 'linux', 'darwin'] as const
    for (const kind of kinds) {
      for (const platform of platforms) {
        for (const arch of ['x64', 'arm64'] as const) {
          for (const candidate of assetCandidates(kind, platform, arch, version)) {
            expect(known, `${kind}/${platform}/${arch} -> ${candidate.name}`).toContain(
              candidate.name
            )
          }
        }
      }
    }
  })

  it('covers every desktop artifact the release workflow publishes', () => {
    const reachable = new Set<string>()
    for (const kind of ['nsis', 'portable', 'appimage', 'deb', 'mac'] as const) {
      for (const arch of ['x64', 'arm64'] as const) {
        for (const c of assetCandidates(kind, 'linux', arch, version)) reachable.add(c.name)
      }
    }
    for (const file of known) {
      if (file.endsWith('.apk')) continue
      expect(reachable, file).toContain(file)
    }
  })

  it('prefers the per-arch installer and falls back to the combined one', () => {
    const r = release('v0.2.0', {
      assets: [
        { name: 'Murmur-0.2.0-setup.exe', size: 200, browser_download_url: 'https://github.com/x' }
      ]
    })
    const picked = pickAsset(r, assetCandidates('nsis', 'win32', 'arm64', '0.2.0'))
    expect(picked?.asset.name).toBe('Murmur-0.2.0-setup.exe')
    expect(picked?.installable).toBe(true)
    r.assets.unshift({
      name: 'Murmur-0.2.0-arm64-setup.exe',
      size: 100,
      browser_download_url: 'https://github.com/y'
    })
    expect(pickAsset(r, assetCandidates('nsis', 'win32', 'arm64', '0.2.0'))?.asset.name).toBe(
      'Murmur-0.2.0-arm64-setup.exe'
    )
  })

  it('never marks a file installable on kinds that cannot self-update', () => {
    for (const kind of ['portable', 'dev', 'unknown'] as const) {
      for (const platform of ['win32', 'linux', 'darwin'] as const) {
        for (const c of assetCandidates(kind, platform, 'x64', version)) {
          expect(c.installable, `${kind}/${platform}/${c.name}`).toBe(false)
        }
      }
    }
    expect(assetCandidates('mac', 'darwin', 'arm64', version)).toEqual([
      { name: 'Murmur-0.2.0-arm64.zip', installable: true },
      { name: 'Murmur-0.2.0-arm64.dmg', installable: false }
    ])
    expect(assetCandidates('appimage', 'linux', 'x64', version)[0].name).toBe(
      'Murmur-0.2.0-x86_64.AppImage'
    )
    expect(assetCandidates('deb', 'linux', 'x64', version)[0].name).toBe('murmur_0.2.0_amd64.deb')
    expect(assetCandidates('nsis', 'win32', null, version)).toEqual([])
    expect(toUpdateArch('ia32')).toBeNull()
  })
})

describe('checksums and trust', () => {
  it('parses sha256sum output in text and binary form', () => {
    const sums = parseChecksums(
      [
        '# comment',
        'ab'.repeat(32) + '  Murmur-0.2.0-setup.exe',
        'CD'.repeat(32) + ' *murmur_0.2.0_amd64.deb\r',
        'not a checksum line',
        ''
      ].join('\n')
    )
    expect(sums.get('Murmur-0.2.0-setup.exe')).toBe('ab'.repeat(32))
    expect(sums.get('murmur_0.2.0_amd64.deb')).toBe('cd'.repeat(32))
    expect(sums.size).toBe(2)
  })

  it('only trusts assets from the release origin (https, or loopback for tests)', () => {
    expect(
      isTrustedAssetUrl(
        'https://github.com/BenItBuhner/voxflow/releases/download/v0.2.0/x.exe',
        'https://github.com'
      )
    ).toBe(true)
    expect(isTrustedAssetUrl('https://evil.example/x.exe', 'https://github.com')).toBe(false)
    expect(isTrustedAssetUrl('http://github.com/x.exe', 'https://github.com')).toBe(false)
    expect(isTrustedAssetUrl('http://127.0.0.1:8080/x.exe', 'http://127.0.0.1:8080')).toBe(true)
    expect(isTrustedAssetUrl('nonsense', 'https://github.com')).toBe(false)
  })

  it('describes a release for the UI', () => {
    const r = release('v0.2.0', { name: '  ', body: null })
    const d = describeRelease(r, null, null)
    expect(d).toMatchObject({
      version: '0.2.0',
      tag: 'v0.2.0',
      name: 'v0.2.0',
      notes: '',
      asset: null
    })
    expect(d.publishedAt).toBe(Date.parse('2026-09-01T10:00:00Z'))
  })
})

describe('detectInstallKind', () => {
  const base = {
    isPackaged: true,
    env: {} as Record<string, string | undefined>,
    execPath: '/opt/Murmur/murmur',
    resourcesPath: '/opt/Murmur/resources',
    exists: () => false,
    readText: () => null as string | null
  }

  it('recognises every packaging layout', () => {
    expect(detectInstallKind({ ...base, platform: 'linux', isPackaged: false })).toBe('dev')
    expect(
      detectInstallKind({ ...base, platform: 'linux', env: { APPIMAGE: '/home/me/murmur' } })
    ).toBe('appimage')
    expect(
      detectInstallKind({
        ...base,
        platform: 'linux',
        readText: (p) => (p.endsWith('package-type') ? 'deb\n' : null)
      })
    ).toBe('deb')
    expect(detectInstallKind({ ...base, platform: 'linux' })).toBe('unknown')
    expect(
      detectInstallKind({
        ...base,
        platform: 'win32',
        execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Murmur\\Murmur.exe',
        exists: (p) => p.endsWith('Uninstall Murmur.exe')
      })
    ).toBe('nsis')
    expect(
      detectInstallKind({
        ...base,
        platform: 'win32',
        env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Tools\\Murmur-portable.exe' }
      })
    ).toBe('portable')
    expect(detectInstallKind({ ...base, platform: 'win32' })).toBe('unknown')
    expect(
      detectInstallKind({
        ...base,
        platform: 'darwin',
        execPath: '/Applications/Murmur.app/Contents/MacOS/Murmur'
      })
    ).toBe('mac')
    expect(detectInstallKind({ ...base, platform: 'darwin', execPath: '/tmp/murmur' })).toBe(
      'unknown'
    )
  })
})

describe('resolveUpdateSource', () => {
  it('reads the repository from the build, the package, or the override', () => {
    expect(repoFromUrl('https://github.com/BenItBuhner/voxflow.git')).toBe('BenItBuhner/voxflow')
    expect(repoFromUrl('git@github.com:Owner/Repo')).toBe('Owner/Repo')
    expect(repoFromUrl('https://gitlab.com/a/b')).toBeNull()

    const fromPackage = resolveUpdateSource(
      {},
      { packageRepositoryUrl: 'https://github.com/Fork/murmur.git' }
    )
    expect(fromPackage.source).toEqual({
      repo: 'Fork/murmur',
      apiBase: 'https://api.github.com',
      downloadOrigin: 'https://github.com'
    })
    expect(fromPackage.warnings).toEqual([])

    expect(resolveUpdateSource({}, { repo: 'Build/repo' }).source.repo).toBe('Build/repo')
    expect(
      resolveUpdateSource({ MURMUR_UPDATE_REPO: 'Env/repo' }, { repo: 'Build/repo' }).source.repo
    ).toBe('Env/repo')

    const bad = resolveUpdateSource({ MURMUR_UPDATE_REPO: 'nope' }, {})
    expect(bad.source.repo).toBe('BenItBuhner/voxflow')
    expect(bad.warnings[0]).toMatch(/invalid update repository/)
  })

  it('moves the download origin along with an API override', () => {
    const { source, warnings } = resolveUpdateSource(
      { MURMUR_UPDATE_API_BASE: 'http://127.0.0.1:4321/api/' },
      { repo: 'Owner/Repo' }
    )
    expect(source.apiBase).toBe('http://127.0.0.1:4321/api')
    expect(source.downloadOrigin).toBe('http://127.0.0.1:4321')
    expect(warnings[0]).toMatch(/overridden/)
    expect(resolveUpdateSource({ MURMUR_UPDATE_API_BASE: 'ftp://x' }, {}).source.apiBase).toBe(
      'https://api.github.com'
    )
  })
})
