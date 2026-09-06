/** Where releases come from. */
export interface UpdateSource {
  /** `owner/name` on GitHub. */
  repo: string
  /** REST API base, normally https://api.github.com. */
  apiBase: string
  /** Only assets served from this origin are downloaded (github.com in production). */
  downloadOrigin: string
}

/** Last resort when neither the build nor package.json names a repository. */
export const DEFAULT_REPO = 'BenItBuhner/voxflow'
export const GITHUB_API = 'https://api.github.com'
export const GITHUB_ORIGIN = 'https://github.com'

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export interface UpdateSourceEnv {
  /** Runtime override, e.g. to follow a fork's releases. */
  MURMUR_UPDATE_REPO?: string
  /** Runtime override of the API base; assets must then be served from the same origin (tests). */
  MURMUR_UPDATE_API_BASE?: string
  [key: string]: string | undefined
}

/** `git@github.com:owner/name.git` / `https://github.com/owner/name.git` -> `owner/name`. */
export function repoFromUrl(url: string | undefined): string | null {
  if (!url) return null
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match && REPO_RE.test(match[1]) ? match[1] : null
}

export function resolveUpdateSource(
  env: UpdateSourceEnv,
  build: { repo?: string; packageRepositoryUrl?: string }
): { source: UpdateSource; warnings: string[] } {
  const warnings: string[] = []
  let repo = DEFAULT_REPO
  const requested = (env.MURMUR_UPDATE_REPO ?? build.repo ?? '').trim()
  const fromPackage = repoFromUrl(build.packageRepositoryUrl)
  if (requested) {
    if (REPO_RE.test(requested)) repo = requested
    else warnings.push(`Ignoring invalid update repository "${requested}" (expected owner/name)`)
  } else if (fromPackage) {
    repo = fromPackage
  }
  if (repo === DEFAULT_REPO && !requested && !fromPackage) {
    warnings.push(`No update repository configured; following ${DEFAULT_REPO}`)
  }

  let apiBase = GITHUB_API
  let downloadOrigin = GITHUB_ORIGIN
  const apiOverride = (env.MURMUR_UPDATE_API_BASE ?? '').trim()
  if (apiOverride) {
    try {
      const url = new URL(apiOverride)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http(s)')
      apiBase = apiOverride.replace(/\/+$/, '')
      downloadOrigin = url.origin
      warnings.push(`Update feed overridden: ${apiBase}`)
    } catch {
      warnings.push(`Ignoring invalid MURMUR_UPDATE_API_BASE "${apiOverride}"`)
    }
  }
  return { source: { repo, apiBase, downloadOrigin }, warnings }
}

/** `VITE_MURMUR_UPDATE_REPO`, baked in by electron-vite (CI sets it to the building repository). */
export function buildTimeUpdateRepo(): string | undefined {
  const env = import.meta.env as unknown as Record<string, string | undefined>
  return env.VITE_MURMUR_UPDATE_REPO
}

export function releasesUrl(source: UpdateSource): string {
  return `${source.apiBase}/repos/${source.repo}/releases?per_page=30`
}

export function releasesPageUrl(source: UpdateSource): string {
  return `${source.downloadOrigin}/${source.repo}/releases`
}
