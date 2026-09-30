import { billingEnabled } from '@/lib/env'

/**
 * Facts the whole site refers to. The GitHub repository is read from MURMUR_UPDATE_REPO, the same
 * variable the desktop and Android updaters use (CI sets it to `github.repository`), so a fork's
 * website points at the fork's releases without a code change.
 */

export const SITE_NAME = 'Murmur'
export const SITE_TAGLINE = 'Hold a key, speak, and clean text lands wherever your cursor is.'
export const SITE_DESCRIPTION =
  'Murmur is voice dictation for Windows, Linux and Android. Speak into any app and polished, punctuated text is typed where your cursor is; the model does the language work and every number is verified.'

const DEFAULT_REPO = 'BenItBuhner/Murmur'
const REPO_RE = /^[\w.-]+\/[\w.-]+$/

export function releasesRepo(): string {
  const configured = process.env.MURMUR_UPDATE_REPO?.trim()
  return configured && REPO_RE.test(configured) ? configured : DEFAULT_REPO
}

export function repoUrl(repo = releasesRepo()): string {
  return `https://github.com/${repo}`
}

export function releasesUrl(repo = releasesRepo()): string {
  return `${repoUrl(repo)}/releases`
}

/** `https://github.com/<repo>/releases/latest/download`, the base of the stable-alias links. */
export function latestDownloadBase(repo = releasesRepo()): string {
  return `${releasesUrl(repo)}/latest/download`
}

/** Absolute origin for metadata; falls back to localhost so a build never needs the variable. */
export function siteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (configured) {
    try {
      return new URL(configured)
    } catch {
      // fall through to the default
    }
  }
  return new URL('http://localhost:3000')
}

export interface SiteLink {
  href: string
  label: string
}

/** The header's primary links; Pricing only while the site sells Pro. */
export function navLinks(selling = billingEnabled): SiteLink[] {
  return [
    { href: '/#engine', label: 'How it works' },
    ...(selling ? [{ href: '/pricing', label: 'Pricing' }] : []),
    { href: '/download', label: 'Download' }
  ]
}

/** The footer's product column: the header links plus the account page. */
export function productLinks(selling = billingEnabled): SiteLink[] {
  return [...navLinks(selling), { href: '/account', label: 'Account' }]
}

/** Every public page for the sitemap, with its priority; /pricing only while it exists. */
export function sitemapPages(selling = billingEnabled): Array<{ path: string; priority: number }> {
  return [
    { path: '/', priority: 1 },
    { path: '/download', priority: 0.9 },
    ...(selling ? [{ path: '/pricing', priority: 0.8 }] : []),
    { path: '/privacy', priority: 0.3 },
    { path: '/terms', priority: 0.3 }
  ]
}
