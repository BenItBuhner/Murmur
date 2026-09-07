/**
 * Types shared between the main process (which owns the Convex connection and the offline mirror),
 * the preload bridge and the renderer (which owns the Clerk session and the UI).
 */

/**
 * How the build treats accounts.
 * - `off`: no cloud configured; the app is fully local (dev builds, self-hosted builds).
 * - `optional`: sign-in is offered but "continue without an account" is allowed.
 * - `required`: the production instance; every user signs up before onboarding.
 */
export type AccountMode = 'off' | 'optional' | 'required'

export type Plan = 'free' | 'pro'

export interface CloudConfig {
  accountMode: AccountMode
  convexUrl: string
  /**
   * Origin of the deployment's HTTP actions (`https://<name>.convex.site`), where the managed
   * inference gateway lives. Empty in local builds.
   */
  convexSiteUrl: string
  clerkPublishableKey: string
  /** Clerk Frontend API host derived from the publishable key, e.g. clerk.murmur.app. */
  clerkFrontendApiHost: string
  /** Custom URL scheme that serves the renderer and receives OAuth deep links. */
  deepLinkScheme: string
  /** Name of the Clerk JWT template that mints Convex tokens. */
  jwtTemplate: string
}

/** What the renderer reports about the Clerk session. */
export interface RendererAuthState {
  signedIn: boolean
  userId?: string
  email?: string
  name?: string
  imageUrl?: string
}

export interface CloudUser {
  id: string
  clerkId: string
  email?: string
  name?: string
  imageUrl?: string
  /** Account tier; decides the managed-inference allowance. */
  plan: Plan
  onboardingCompletedAt?: number
  onboardingVersion?: number
}

/** What the instance offers the signed-in account in managed models, and how much is left. */
export interface InferenceStatus {
  /** The instance is configured with at least a managed speech model. */
  available: boolean
  models: { stt: string | null; llm: string | null }
  plan: Plan
  limits: {
    sttSecondsPerMonth: number
    llmTokensPerMonth: number
    requestsPerMinute: number
    maxClipSeconds: number
  }
  /** Newest month with any usage (`YYYY-MM`, UTC); other months count as zero. */
  usage: {
    period: string
    sttSeconds: number
    sttRequests: number
    llmTokens: number
    llmRequests: number
  }
}

export interface CloudDevice {
  deviceId: string
  name: string
  platform: string
  appVersion: string
  lastSeenAt: number
  createdAt: number
  /** True for the device this app is running on. */
  current: boolean
}

export type SyncPhase =
  | 'disabled' // accountMode off
  | 'signed-out'
  | 'connecting'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'error'

export interface SyncStatus {
  configured: boolean
  phase: SyncPhase
  signedIn: boolean
  /** True once the Convex WebSocket is authenticated with a Clerk token. */
  authenticated: boolean
  connected: boolean
  pendingOps: number
  lastSyncedAt?: number
  error?: string
  user: CloudUser | null
  devices: CloudDevice[]
  deviceId: string
  /** Managed-model availability and allowance; null until the account is connected. */
  inference: InferenceStatus | null
}

/** Current UTC month as `YYYY-MM`, the period the gateway bills usage to. */
export function currentUsagePeriod(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface TokenRequest {
  id: string
  forceRefresh: boolean
}

export interface TokenResponse {
  id: string
  token: string | null
  error?: string
}

export const ONBOARDING_VERSION = 1

export const DEFAULT_DEEP_LINK_SCHEME = 'murmur'
export const DEFAULT_JWT_TEMPLATE = 'convex'
