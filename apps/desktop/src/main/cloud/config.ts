import {
  DEFAULT_DEEP_LINK_SCHEME,
  DEFAULT_JWT_TEMPLATE,
  type AccountMode,
  type CloudConfig
} from '@shared/cloud'

/** Runtime overrides (developer convenience, mirrors MURMUR_BASE_URL for providers). */
export interface CloudEnv {
  MURMUR_CONVEX_URL?: string
  MURMUR_CLERK_PUBLISHABLE_KEY?: string
  MURMUR_ACCOUNT_MODE?: string
  MURMUR_DEEP_LINK_SCHEME?: string
  [key: string]: string | undefined
}

/** Values baked in at build time through Vite env vars (see .env.example). */
export interface CloudBuildConfig {
  convexUrl?: string
  clerkPublishableKey?: string
  accountMode?: string
  deepLinkScheme?: string
}

export interface ResolvedCloudConfig {
  config: CloudConfig
  warnings: string[]
}

const ACCOUNT_MODES: readonly AccountMode[] = ['off', 'optional', 'required']

/**
 * Clerk publishable keys encode the instance's Frontend API host:
 * `pk_test_` / `pk_live_` followed by base64("clerk.example.com$").
 */
export function frontendApiFromPublishableKey(publishableKey: string): string | null {
  const match = /^pk_(test|live)_([A-Za-z0-9+/=]+)$/.exec(publishableKey.trim())
  if (!match) return null
  try {
    const host = Buffer.from(match[2], 'base64').toString('utf8').replace(/\$$/, '')
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)
      ? host
      : null
  } catch {
    return null
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isValidScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*$/.test(value)
}

/**
 * Decide how this build treats accounts. Environment variables win over build-time values so a
 * developer can point a local build at a staging instance, or force local mode with
 * MURMUR_ACCOUNT_MODE=off. Without a valid Convex URL and Clerk key the app is always local.
 */
export function resolveCloudConfig(env: CloudEnv, build: CloudBuildConfig): ResolvedCloudConfig {
  const warnings: string[] = []
  const convexUrl = (env.MURMUR_CONVEX_URL ?? build.convexUrl ?? '').trim()
  const clerkPublishableKey = (
    env.MURMUR_CLERK_PUBLISHABLE_KEY ??
    build.clerkPublishableKey ??
    ''
  ).trim()
  const requestedMode = (env.MURMUR_ACCOUNT_MODE ?? build.accountMode ?? '').trim().toLowerCase()
  const requestedScheme = (env.MURMUR_DEEP_LINK_SCHEME ?? build.deepLinkScheme ?? '')
    .trim()
    .toLowerCase()

  let deepLinkScheme = DEFAULT_DEEP_LINK_SCHEME
  if (requestedScheme) {
    if (isValidScheme(requestedScheme)) deepLinkScheme = requestedScheme
    else warnings.push(`Ignoring invalid deep link scheme "${requestedScheme}"`)
  }

  const off: CloudConfig = {
    accountMode: 'off',
    convexUrl: '',
    clerkPublishableKey: '',
    clerkFrontendApiHost: '',
    deepLinkScheme,
    jwtTemplate: DEFAULT_JWT_TEMPLATE
  }

  if (requestedMode === 'off') return { config: off, warnings }

  const hasAny = !!convexUrl || !!clerkPublishableKey
  if (!convexUrl || !isHttpUrl(convexUrl)) {
    if (hasAny)
      warnings.push(
        'Cloud disabled: MURMUR_CONVEX_URL / VITE_CONVEX_URL is missing or not an http(s) URL'
      )
    return { config: off, warnings }
  }
  const clerkFrontendApiHost = frontendApiFromPublishableKey(clerkPublishableKey)
  if (!clerkFrontendApiHost) {
    warnings.push(
      'Cloud disabled: MURMUR_CLERK_PUBLISHABLE_KEY / VITE_CLERK_PUBLISHABLE_KEY is missing or not a Clerk publishable key'
    )
    return { config: off, warnings }
  }

  let accountMode: AccountMode = 'required'
  if (requestedMode) {
    if ((ACCOUNT_MODES as readonly string[]).includes(requestedMode))
      accountMode = requestedMode as AccountMode
    else warnings.push(`Unknown account mode "${requestedMode}", defaulting to "required"`)
  }

  return {
    config: {
      accountMode,
      convexUrl: convexUrl.replace(/\/+$/, ''),
      clerkPublishableKey,
      clerkFrontendApiHost,
      deepLinkScheme,
      jwtTemplate: DEFAULT_JWT_TEMPLATE
    },
    warnings
  }
}

/** Build-time values injected by electron-vite from VITE_* variables. */
export function buildTimeCloudConfig(): CloudBuildConfig {
  const env = import.meta.env as unknown as Record<string, string | undefined>
  return {
    convexUrl: env.VITE_CONVEX_URL,
    clerkPublishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
    accountMode: env.VITE_MURMUR_ACCOUNT_MODE,
    deepLinkScheme: env.VITE_MURMUR_DEEP_LINK_SCHEME
  }
}
