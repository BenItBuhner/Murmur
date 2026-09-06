import type { InstallKind, UpdateRelease } from '@shared/updates'
import { compareVersions, isPrerelease, normalizeVersion, parseVersion } from './version'

/** The subset of GitHub's release JSON (`GET /repos/{owner}/{repo}/releases`) the updater reads. */
export interface GithubReleaseAsset {
  name: string
  size: number
  browser_download_url: string
}

export interface GithubRelease {
  tag_name: string
  name: string | null
  draft: boolean
  prerelease: boolean
  published_at: string | null
  html_url: string
  body: string | null
  assets: GithubReleaseAsset[]
}

export const CHECKSUMS_ASSET = 'SHA256SUMS.txt'

export interface SelectReleaseOptions {
  currentVersion: string
  includePrereleases: boolean
  /** A version the user dismissed; the newest release is withheld while it is still that one. */
  skippedVersion?: string
}

/**
 * The newest release that is newer than the running version, honouring the pre-release policy.
 * Pre-releases are considered when opted in or when the running build is itself a pre-release
 * (someone on 0.2.0-beta.1 wants beta.2, and 0.2.0 once it ships).
 */
export function selectRelease(
  releases: GithubRelease[],
  opts: SelectReleaseOptions
): GithubRelease | null {
  const allowPre = opts.includePrereleases || isPrerelease(opts.currentVersion)
  let best: GithubRelease | null = null
  for (const release of releases) {
    if (release.draft) continue
    if (!parseVersion(release.tag_name)) continue
    if ((release.prerelease || isPrerelease(release.tag_name)) && !allowPre) continue
    if (best === null || compareVersions(release.tag_name, best.tag_name) > 0) best = release
  }
  if (!best) return null
  if (compareVersions(best.tag_name, opts.currentVersion) <= 0) return null
  if (opts.skippedVersion && compareVersions(best.tag_name, opts.skippedVersion) === 0) return null
  return best
}

export interface AssetCandidate {
  name: string
  /** Whether the updater knows how to apply this file on the given install kind. */
  installable: boolean
}

export type UpdateArch = 'x64' | 'arm64'

export function toUpdateArch(arch: string): UpdateArch | null {
  return arch === 'x64' || arch === 'arm64' ? arch : null
}

/**
 * Release files that fit an install, best first. Names must match the artifactName patterns in
 * apps/desktop/electron-builder.yml, i.e. the `file` entries of ASSETS in scripts/release.mjs.
 */
export function assetCandidates(
  kind: InstallKind,
  platform: NodeJS.Platform,
  arch: UpdateArch | null,
  version: string
): AssetCandidate[] {
  const v = normalizeVersion(version)
  if (!arch) return []
  const nsis = [
    { name: `Murmur-${v}-${arch}-setup.exe`, installable: true },
    // The combined x64+arm64 installer works everywhere, it is just twice the download.
    { name: `Murmur-${v}-setup.exe`, installable: true }
  ]
  const portable = [{ name: `Murmur-${v}-portable.exe`, installable: false }]
  const appImage = [
    { name: `Murmur-${v}-${arch === 'x64' ? 'x86_64' : 'arm64'}.AppImage`, installable: true }
  ]
  const deb = [{ name: `murmur_${v}_${arch === 'x64' ? 'amd64' : 'arm64'}.deb`, installable: true }]
  const macZip = { name: `Murmur-${v}-${arch}.zip`, installable: true }
  const macDmg = { name: `Murmur-${v}-${arch}.dmg`, installable: false }

  const manual = (list: AssetCandidate[]): AssetCandidate[] =>
    list.map((c) => ({ ...c, installable: false }))

  switch (kind) {
    case 'nsis':
      return nsis
    case 'portable':
      return portable
    case 'appimage':
      return appImage
    case 'deb':
      return deb
    case 'mac':
      return [macZip, macDmg]
    case 'dev':
    case 'unknown':
      // Nothing can be applied in place; offer the platform's regular download for the user.
      if (platform === 'win32') return manual(nsis)
      if (platform === 'darwin') return [macDmg, { ...macZip, installable: false }]
      if (platform === 'linux') return manual(appImage)
      return []
    default:
      return []
  }
}

/** First candidate the release actually ships. */
export function pickAsset(
  release: GithubRelease,
  candidates: AssetCandidate[]
): { asset: GithubReleaseAsset; installable: boolean } | null {
  for (const candidate of candidates) {
    const asset = release.assets.find((a) => a.name === candidate.name)
    if (asset) return { asset, installable: candidate.installable }
  }
  return null
}

/**
 * Parse `sha256sum` output (`<hex>  <name>`, also the `*<name>` binary-mode form) into a map of
 * file name -> lowercase hex digest.
 */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)
    if (!match) continue
    out.set(match[2].trim(), match[1].toLowerCase())
  }
  return out
}

/** Downloads are only accepted from the origin the release feed lives on. */
export function isTrustedAssetUrl(url: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(url)
    const allowed = new URL(allowedOrigin)
    if (parsed.origin !== allowed.origin) return false
    return parsed.protocol === 'https:' || isLoopback(parsed.hostname)
  } catch {
    return false
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function describeRelease(
  release: GithubRelease,
  asset: GithubReleaseAsset | null,
  sha256: string | null
): UpdateRelease {
  const publishedAt = release.published_at ? Date.parse(release.published_at) : NaN
  return {
    version: normalizeVersion(release.tag_name),
    tag: release.tag_name,
    name: release.name?.trim() || release.tag_name,
    url: release.html_url,
    publishedAt: Number.isNaN(publishedAt) ? null : publishedAt,
    prerelease: release.prerelease || isPrerelease(release.tag_name),
    notes: release.body ?? '',
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
    sha256
  }
}
