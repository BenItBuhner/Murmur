/**
 * Ephemeris's plans, from one person to a company. Everything local stays free and unlimited:
 * missions, dictation with your own speech model, connected apps, the MCP server and CLI. Plans
 * cover what runs in the cloud: sync across devices, shared team workspaces, the managed models
 * (speech, meeting notes and the agent, without bringing a key), and company controls.
 *
 * A new account gets a 14-day Pro trial; a new team gets a 14-day Team trial. When a trial ends
 * without a subscription the workspace keeps its data and drops to Free's limits.
 */
export type Plan = 'free' | 'pro' | 'team' | 'enterprise'
export type PlanState = 'trial' | 'active' | 'past_due' | 'canceled'
export type Role = 'owner' | 'admin' | 'member'

export interface Entitlements {
  plan: Plan
  /** Records (missions, steps, items, meetings...) the workspace may keep in sync; null = no cap. */
  syncRecords: number | null
  /** People in the workspace, counting the owner. */
  seats: number
  /** Ephemeris's own speech model, meeting notes and agent, with no key of your own. */
  managedModels: boolean
  /** Hours of meetings the managed models transcribe per month; null = fair use. */
  meetingHoursPerMonth: number | null
  /** Shared missions and a shared inbox. */
  sharedWorkspace: boolean
  /** Single sign-on, join by email domain, connector policy, retention, the audit log export. */
  companyControls: boolean
}

export const TRIAL_DAYS = 14
export const DAY_MS = 86_400_000

const LIMITS: Record<Plan, Omit<Entitlements, 'plan' | 'seats'> & { seats: number | 'paid' }> = {
  free: { syncRecords: 2_000, seats: 1, managedModels: false, meetingHoursPerMonth: 0, sharedWorkspace: false, companyControls: false },
  pro: { syncRecords: 250_000, seats: 1, managedModels: true, meetingHoursPerMonth: 40, sharedWorkspace: false, companyControls: false },
  team: { syncRecords: 1_000_000, seats: 'paid', managedModels: true, meetingHoursPerMonth: 60, sharedWorkspace: true, companyControls: false },
  enterprise: { syncRecords: null, seats: 'paid', managedModels: true, meetingHoursPerMonth: null, sharedWorkspace: true, companyControls: true }
}

/** Prices shown in the app, per seat per month. Stripe holds the real ones (env price ids). */
export const PRICES: Record<Exclude<Plan, 'free' | 'enterprise'>, { monthly: number; yearly: number }> = {
  pro: { monthly: 15, yearly: 144 },
  team: { monthly: 25, yearly: 240 }
}

export interface PlanFields {
  kind: 'personal' | 'team'
  plan: Plan
  planState: PlanState
  trialEndsAt?: number
  seats: number
}

/** The plan whose limits apply right now: an ended trial or a canceled subscription is Free. */
export function effectivePlan(ws: PlanFields, now: number): Plan {
  if (ws.planState === 'canceled') return 'free'
  if (ws.planState === 'trial' && (ws.trialEndsAt ?? 0) < now) return 'free'
  return ws.plan
}

export function entitlements(ws: PlanFields, now: number): Entitlements {
  const plan = effectivePlan(ws, now)
  const l = LIMITS[plan]
  // A team that falls back to Free keeps its members (nobody is locked out) but can't add more.
  const seats = l.seats === 'paid' ? Math.max(1, ws.seats) : ws.kind === 'team' ? ws.seats : 1
  return { ...l, plan, seats }
}

/** Who may do what. Owners and admins run the workspace; members work in it. */
export function can(role: Role, action: 'invite' | 'billing' | 'policy' | 'remove' | 'rename' | 'ephemerisAudit'): boolean {
  if (role === 'owner') return true
  if (role === 'admin') return action !== 'billing'
  return false
}

export function trialEnds(now: number): number {
  return now + TRIAL_DAYS * DAY_MS
}
