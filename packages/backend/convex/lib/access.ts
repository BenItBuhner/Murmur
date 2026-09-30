import type { AccessState, PlanState } from './plans'

/**
 * Private testing. While `MURMUR_ALLOWED_EMAILS` (deployment environment variable, comma-separated
 * email addresses) is set, the instance's managed models are open only to the accounts on it: those
 * get the `unlimited` tier, every other signed-in account is `testing` and every gateway request of
 * theirs is refused with `PRIVATE_TESTING_MESSAGE`. Sign-in, sync and the account page keep working
 * for everyone; the gate is on usage. Unset (or blank), the list does nothing and accounts are on
 * their plan states (see lib/plans.ts).
 *
 * The email comes from the Clerk session token (`email` claim of the `convex` JWT template) and,
 * when the token carries none, from the account row the Clerk webhook wrote. A token that says
 * `email_verified: false` never counts as on the list: the list is of addresses their owners hold.
 */

export const PRIVATE_TESTING_CODE = 'private_testing'
export const PRIVATE_TESTING_MESSAGE =
  "This Murmur server is in private testing: its speech and formatting models are not open to this account yet. Connect a provider of your own under Models to keep dictating."

export type Env = Record<string, string | undefined>

/** The claims the list reads off a session token (a subset of Convex's `UserIdentity`). */
export interface AccessIdentity {
  email?: string | null
  emailVerified?: boolean | null
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** The list, or null when the instance is not in private testing. */
export function allowedEmails(env: Env): ReadonlySet<string> | null {
  const raw = env.MURMUR_ALLOWED_EMAILS
  if (raw === undefined) return null
  const list = raw.split(',').map(normalizeEmail).filter(Boolean)
  return list.length ? new Set(list) : null
}

export function privateTesting(env: Env): boolean {
  return allowedEmails(env) !== null
}

/** Is the account behind `identity` (with `storedEmail` as the fallback address) on the list? */
export function onAllowlist(
  env: Env,
  identity: AccessIdentity | null | undefined,
  storedEmail?: string | null
): boolean {
  const list = allowedEmails(env)
  if (!list) return false
  if (identity?.emailVerified === false) return false
  const email = identity?.email ?? storedEmail
  return typeof email === 'string' && list.has(normalizeEmail(email))
}

/**
 * The state the account is reported and metered in: its stored plan state, or during private
 * testing `unlimited` / `testing` by the list.
 */
export function accessStateOf(
  env: Env,
  stored: PlanState,
  identity: AccessIdentity | null | undefined,
  storedEmail?: string | null
): AccessState {
  if (!privateTesting(env)) return stored
  return onAllowlist(env, identity, storedEmail) ? 'unlimited' : 'testing'
}
