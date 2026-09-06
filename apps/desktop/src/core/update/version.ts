/**
 * Minimal semver (https://semver.org) parsing and precedence, enough to order Murmur releases.
 * Mirrors scripts/release.mjs (tags are `vX.Y.Z` or `vX.Y.Z-pre.N`, never with build metadata)
 * and the Android implementation in apps/android/.../update/Semver.kt.
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Dot-separated pre-release identifiers, empty for a stable release. */
  prerelease: string[]
}

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

/** Parse `1.2.3`, `v1.2.3` or `1.2.3-beta.4`; build metadata is accepted and ignored. */
export function parseVersion(input: string): ParsedVersion | null {
  const match = SEMVER_RE.exec(input.trim())
  if (!match) return null
  const [, major, minor, patch, prerelease] = match
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : []
  }
}

export function isPrerelease(version: string): boolean {
  return (parseVersion(version)?.prerelease.length ?? 0) > 0
}

/** Strip a leading `v` so tags and package versions compare and display alike. */
export function normalizeVersion(input: string): string {
  return input.trim().replace(/^v/, '')
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Math.sign(Number(a) - Number(b))
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Semver precedence: negative when `a` is older than `b`, 0 when equal, positive when newer. */
export function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return Math.sign(a.major - b.major)
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor)
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch)
  // A version without a pre-release tag is newer than the same version with one.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const n = Math.min(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < n; i++) {
    const c = compareIdentifiers(a.prerelease[i], b.prerelease[i])
    if (c !== 0) return c
  }
  return Math.sign(a.prerelease.length - b.prerelease.length)
}

/**
 * Compare two version strings. Unparseable input sorts below every valid version so a malformed
 * tag can never be offered as an update.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  return compareParsed(pa, pb)
}
