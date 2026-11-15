/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import schema from '../convex/schema'
import { entitlements, effectivePlan, can, DAY_MS } from '../convex/ephemeris/lib/plans'
import { wins } from '../convex/ephemeris/lib/merge'
import { checkoutSessionParams, parseStripeEvent, planForPrice, readStripeConfig, verifyStripeSignature } from '../convex/ephemeris/lib/stripe'

const modules = import.meta.glob('../convex/**/*.ts')

const ANA = { subject: 'user_ana', email: 'ana@acme.com', name: 'Ana', emailVerified: true }
const BO = { subject: 'user_bo', email: 'bo@acme.com', name: 'Bo', emailVerified: true }
const CY = { subject: 'user_cy', email: 'cy@else.org', name: 'Cy', emailVerified: true }

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function setup() {
  const t = convexTest(schema, modules)
  const ana = t.withIdentity(ANA)
  const { workspaces } = await ana.mutation(api.ephemeris.account.bootstrap, {})
  return { t, ana, personal: workspaces[0]!.id as never }
}

describe('plans', () => {
  const base = { kind: 'personal' as const, seats: 1 }
  it('trials end on Free and canceled plans are Free', () => {
    const now = 1_000 * DAY_MS
    expect(effectivePlan({ ...base, plan: 'pro', planState: 'trial', trialEndsAt: now + 1 }, now)).toBe('pro')
    expect(effectivePlan({ ...base, plan: 'pro', planState: 'trial', trialEndsAt: now - 1 }, now)).toBe('free')
    expect(effectivePlan({ ...base, plan: 'team', planState: 'canceled' }, now)).toBe('free')
    expect(effectivePlan({ ...base, plan: 'pro', planState: 'past_due' }, now)).toBe('pro')
  })
  it('gives each plan its limits', () => {
    const now = 0
    expect(entitlements({ ...base, plan: 'free', planState: 'active' }, now)).toMatchObject({ syncRecords: 2000, managedModels: false, seats: 1 })
    expect(entitlements({ kind: 'team', seats: 12, plan: 'team', planState: 'active' }, now)).toMatchObject({ seats: 12, sharedWorkspace: true, companyControls: false })
    expect(entitlements({ kind: 'team', seats: 40, plan: 'enterprise', planState: 'active' }, now)).toMatchObject({ syncRecords: null, companyControls: true })
    // A lapsed team keeps everyone it has.
    expect(entitlements({ kind: 'team', seats: 7, plan: 'team', planState: 'canceled' }, now).seats).toBe(7)
  })
  it('lets owners bill and admins run the rest', () => {
    expect(can('owner', 'billing')).toBe(true)
    expect(can('admin', 'billing')).toBe(false)
    expect(can('admin', 'invite')).toBe(true)
    expect(can('member', 'invite')).toBe(false)
  })
})

describe('merge', () => {
  it('takes the later version, then the larger device', () => {
    expect(wins({ version: 2, deviceId: 'a' }, { version: 1, deviceId: 'z' })).toBe(true)
    expect(wins({ version: 1, deviceId: 'z' }, { version: 2, deviceId: 'a' })).toBe(false)
    expect(wins({ version: 2, deviceId: 'b' }, { version: 2, deviceId: 'a' })).toBe(true)
    expect(wins({ version: 2, deviceId: 'a' }, { version: 2, deviceId: 'b' })).toBe(false)
    expect(wins({ version: 1, deviceId: 'a' }, null)).toBe(true)
  })
})

describe('accounts', () => {
  it('makes an account with a personal workspace on a Pro trial, once', async () => {
    const { ana } = await setup()
    await ana.mutation(api.ephemeris.account.bootstrap, {})
    const me = await ana.query(api.ephemeris.account.me, {})
    expect(me?.user.email).toBe('ana@acme.com')
    expect(me?.workspaces).toHaveLength(1)
    expect(me?.workspaces[0]).toMatchObject({ kind: 'personal', role: 'owner', plan: 'pro', planState: 'trial' })
    expect(me?.workspaces[0]?.entitlements.plan).toBe('pro')
  })
  it('returns nothing for a signed-out caller and refuses their writes', async () => {
    const t = convexTest(schema, modules)
    expect(await t.query(api.ephemeris.account.me, {})).toBeNull()
    await expect(t.mutation(api.ephemeris.account.bootstrap, {})).rejects.toThrow(/Sign in/)
  })
  it('drops to Free when the trial runs out', async () => {
    vi.useFakeTimers()
    const { ana } = await setup()
    vi.setSystemTime(Date.now() + 15 * DAY_MS)
    const me = await ana.query(api.ephemeris.account.me, {})
    expect(me?.workspaces[0]?.entitlements.plan).toBe('free')
  })
})

describe('teams', () => {
  it('invites, accepts and lists members', async () => {
    const { t, ana } = await setup()
    const team = await ana.mutation(api.ephemeris.workspaces.createTeam, { name: '  Acme   Launch ' })
    const { token } = await ana.mutation(api.ephemeris.workspaces.invite, { workspaceId: team, email: 'Bo@Acme.com' })
    const again = await ana.mutation(api.ephemeris.workspaces.invite, { workspaceId: team, email: 'bo@acme.com' })
    expect(again).toEqual({ token, reused: true })

    const bo = t.withIdentity(BO)
    await bo.mutation(api.ephemeris.account.bootstrap, {})
    const mine = await bo.query(api.ephemeris.account.me, {})
    expect(mine?.invites).toEqual([{ token, workspace: 'Acme Launch', role: 'member', from: 'Ana' }])
    await bo.mutation(api.ephemeris.workspaces.acceptInvite, { token })

    const list = await ana.query(api.ephemeris.workspaces.members, { workspaceId: team })
    expect(list.people.map((p) => p.email).sort()).toEqual(['ana@acme.com', 'bo@acme.com'])
    expect(list.invites).toHaveLength(0)
    expect(list.seatsLeft).toBe(3)
    // Members can't invite or read the audit log.
    await expect(bo.mutation(api.ephemeris.workspaces.invite, { workspaceId: team, email: 'x@y.com' })).rejects.toThrow(/owner or an admin/)
    await expect(bo.query(api.ephemeris.workspaces.auditLog, { workspaceId: team })).rejects.toThrow()
    const log = await ana.query(api.ephemeris.workspaces.auditLog, { workspaceId: team })
    expect(log.map((l) => l.action)).toEqual(['member.joined', 'member.invited', 'workspace.created'])
  })

  it('keeps outsiders out', async () => {
    const { t, ana } = await setup()
    const team = await ana.mutation(api.ephemeris.workspaces.createTeam, { name: 'Acme' })
    const cy = t.withIdentity(CY)
    await cy.mutation(api.ephemeris.account.bootstrap, {})
    await expect(cy.query(api.ephemeris.workspaces.members, { workspaceId: team })).rejects.toThrow(/not in that workspace/)
    await expect(cy.query(api.ephemeris.sync.pull, { workspaceId: team, after: 0 })).rejects.toThrow(/not in that workspace/)
  })

  it('stops inviting when the seats are taken', async () => {
    const { ana } = await setup()
    const team = await ana.mutation(api.ephemeris.workspaces.createTeam, { name: 'Acme' })
    for (const n of [1, 2, 3, 4]) await ana.mutation(api.ephemeris.workspaces.invite, { workspaceId: team, email: `p${n}@acme.com` })
    await expect(ana.mutation(api.ephemeris.workspaces.invite, { workspaceId: team, email: 'p5@acme.com' })).rejects.toThrow(/seat/)
  })

  it('refuses invites into a personal workspace', async () => {
    const { ana, personal } = await setup()
    await expect(ana.mutation(api.ephemeris.workspaces.invite, { workspaceId: personal, email: 'bo@acme.com' })).rejects.toThrow(/Personal/)
  })

  it('hands over ownership, then lets the old owner leave', async () => {
    const { t, ana } = await setup()
    const team = await ana.mutation(api.ephemeris.workspaces.createTeam, { name: 'Acme' })
    const { token } = await ana.mutation(api.ephemeris.workspaces.invite, { workspaceId: team, email: 'bo@acme.com' })
    const bo = t.withIdentity(BO)
    await bo.mutation(api.ephemeris.workspaces.acceptInvite, { token })
    await expect(ana.mutation(api.ephemeris.workspaces.leave, { workspaceId: team })).rejects.toThrow(/Hand the workspace/)
    const boId = (await ana.query(api.ephemeris.workspaces.members, { workspaceId: team })).people.find((p) => p.email === 'bo@acme.com')!.userId
    await ana.mutation(api.ephemeris.workspaces.setRole, { workspaceId: team, userId: boId, role: 'owner' })
    await ana.mutation(api.ephemeris.workspaces.leave, { workspaceId: team })
    const list = await bo.query(api.ephemeris.workspaces.members, { workspaceId: team })
    expect(list.people).toEqual([expect.objectContaining({ email: 'bo@acme.com', role: 'owner' })])
  })

  it('lets Enterprise claim an email domain, and new people join by it', async () => {
    const { t, ana } = await setup()
    const team = await ana.mutation(api.ephemeris.workspaces.createTeam, { name: 'Acme' })
    await expect(ana.mutation(api.ephemeris.workspaces.setPolicy, { workspaceId: team, ssoDomain: 'acme.com' })).rejects.toThrow(/Enterprise/)
    await t.run(async (ctx) => ctx.db.patch(team, { plan: 'enterprise', planState: 'active', seats: 50 }))
    await expect(ana.mutation(api.ephemeris.workspaces.setPolicy, { workspaceId: team, ssoDomain: 'else.org' })).rejects.toThrow(/your own email/)
    await ana.mutation(api.ephemeris.workspaces.setPolicy, { workspaceId: team, ssoDomain: '@ACME.com', retentionDays: 30, allowedApps: ['linear', 'linear', 'notion'] })
    const bo = t.withIdentity(BO)
    const { workspaces } = await bo.mutation(api.ephemeris.account.bootstrap, {})
    expect(workspaces.map((w) => w.name)).toEqual(['Personal', 'Acme'])
    const cy = t.withIdentity(CY)
    expect((await cy.mutation(api.ephemeris.account.bootstrap, {})).workspaces).toHaveLength(1)
    const list = await ana.query(api.ephemeris.workspaces.members, { workspaceId: team })
    expect(list.policy).toEqual({ ssoDomain: 'acme.com', allowedApps: ['linear', 'notion'], retentionDays: 30 })
  })
})

describe('sync', () => {
  const change = (recordId: string, version: number, data: object | null, table = 'missions') => ({
    table,
    recordId,
    version,
    data: data ? JSON.stringify(data) : null
  })

  it('round-trips changes between devices and settles conflicts the same way everywhere', async () => {
    const { ana, personal } = await setup()
    const first = await ana.mutation(api.ephemeris.sync.push, {
      workspaceId: personal,
      deviceId: 'laptop',
      changes: [change('m1', 100, { title: 'Launch' }), change('m2', 100, { title: 'Hire' })]
    })
    expect(first).toMatchObject({ accepted: 2, stale: [], refused: [], seq: 2 })

    // The desktop edits m1 later; the laptop's older edit then loses and gets the winner back.
    await ana.mutation(api.ephemeris.sync.push, { workspaceId: personal, deviceId: 'desktop', changes: [change('m1', 200, { title: 'Launch v2' })] })
    const late = await ana.mutation(api.ephemeris.sync.push, { workspaceId: personal, deviceId: 'laptop', changes: [change('m1', 150, { title: 'stale' })] })
    expect(late.accepted).toBe(0)
    expect(late.stale).toEqual([expect.objectContaining({ recordId: 'm1', version: 200, deviceId: 'desktop' })])

    // Sending the same change twice is harmless.
    const dup = await ana.mutation(api.ephemeris.sync.push, { workspaceId: personal, deviceId: 'desktop', changes: [change('m1', 200, { title: 'Launch v2' })] })
    expect(dup).toMatchObject({ accepted: 1, stale: [] })

    const all = await ana.query(api.ephemeris.sync.pull, { workspaceId: personal, after: 0 })
    expect(all.changes.map((c) => [c.recordId, JSON.parse(c.data!).title])).toEqual([['m2', 'Hire'], ['m1', 'Launch v2']])
    expect(all).toMatchObject({ cursor: 3, head: 3, more: false })
    expect((await ana.query(api.ephemeris.sync.pull, { workspaceId: personal, after: 3 })).changes).toEqual([])

    // Deletes travel as tombstones.
    await ana.mutation(api.ephemeris.sync.push, { workspaceId: personal, deviceId: 'laptop', changes: [change('m2', 300, null)] })
    const del = await ana.query(api.ephemeris.sync.pull, { workspaceId: personal, after: 3 })
    expect(del.changes).toEqual([expect.objectContaining({ recordId: 'm2', data: null })])
    expect(await ana.query(api.ephemeris.sync.status, { workspaceId: personal })).toMatchObject({ records: 1, head: 4 })
  })

  it('takes a second change from the same device with the same version', async () => {
    const { ana, personal } = await setup()
    await ana.mutation(api.ephemeris.sync.push, { workspaceId: personal, deviceId: 'd', changes: [change('m1', 5, { title: 'A' })] })
    const r = await ana.mutation(api.ephemeris.sync.push, { workspaceId: personal, deviceId: 'd', changes: [change('m1', 5, { title: 'B' })] })
    expect(r).toMatchObject({ accepted: 1, stale: [] })
    const all = await ana.query(api.ephemeris.sync.pull, { workspaceId: personal, after: 0 })
    expect(all.changes.map((c) => JSON.parse(c.data!).title)).toEqual(['B'])
  })

  it('pages through long histories', async () => {
    const { ana, personal } = await setup()
    const changes = Array.from({ length: 150 }, (_, i) => change(`s${i}`, 1, { i }, 'steps'))
    await ana.mutation(api.ephemeris.sync.push, { workspaceId: personal, deviceId: 'd', changes })
    const a = await ana.query(api.ephemeris.sync.pull, { workspaceId: personal, after: 0, limit: 100 })
    expect(a.changes).toHaveLength(100)
    expect(a.more).toBe(true)
    const b = await ana.query(api.ephemeris.sync.pull, { workspaceId: personal, after: a.cursor, limit: 100 })
    expect(b.changes).toHaveLength(50)
    expect(b.more).toBe(false)
  })

  it('refuses unknown tables and records past the plan limit', async () => {
    vi.useFakeTimers()
    const { t, ana, personal } = await setup()
    const odd = await ana.mutation(api.ephemeris.sync.push, { workspaceId: personal, deviceId: 'd', changes: [change('x', 1, {}, 'secrets')] })
    expect(odd.refused).toEqual([{ table: 'secrets', recordId: 'x', reason: 'unknown' }])

    await t.run(async (ctx) => ctx.db.patch(personal, { records: 1999 }))
    vi.setSystemTime(Date.now() + 15 * DAY_MS) // trial over: Free allows 2,000
    const r = await ana.mutation(api.ephemeris.sync.push, { workspaceId: personal, deviceId: 'd', changes: [change('a', 1, {}), change('b', 1, {})] })
    expect(r.accepted).toBe(1)
    expect(r.refused).toEqual([{ table: 'missions', recordId: 'b', reason: 'limit' }])
    // Edits and deletes of existing records still go through at the limit.
    const edit = await ana.mutation(api.ephemeris.sync.push, { workspaceId: personal, deviceId: 'd', changes: [change('a', 2, { v: 2 })] })
    expect(edit.accepted).toBe(1)
  })

  it('shares a team workspace between its members', async () => {
    const { t, ana } = await setup()
    const team = await ana.mutation(api.ephemeris.workspaces.createTeam, { name: 'Acme' })
    const { token } = await ana.mutation(api.ephemeris.workspaces.invite, { workspaceId: team, email: 'bo@acme.com' })
    const bo = t.withIdentity(BO)
    await bo.mutation(api.ephemeris.workspaces.acceptInvite, { token })
    await ana.mutation(api.ephemeris.sync.push, { workspaceId: team, deviceId: 'ana-mac', changes: [change('m1', 1, { title: 'Shared' })] })
    const seen = await bo.query(api.ephemeris.sync.pull, { workspaceId: team, after: 0 })
    expect(seen.changes).toEqual([expect.objectContaining({ recordId: 'm1', deviceId: 'ana-mac' })])
  })

  it('retention turns old meetings into tombstones and leaves missions alone', async () => {
    vi.useFakeTimers()
    const { t, ana } = await setup()
    const team = await ana.mutation(api.ephemeris.workspaces.createTeam, { name: 'Acme' })
    await t.run(async (ctx) => ctx.db.patch(team, { plan: 'enterprise', planState: 'active', seats: 10 }))
    await ana.mutation(api.ephemeris.workspaces.setPolicy, { workspaceId: team, retentionDays: 30 })
    await ana.mutation(api.ephemeris.sync.push, {
      workspaceId: team,
      deviceId: 'd',
      changes: [change('r1', 1, { title: 'Standup' }, 'recordings'), change('m1', 1, { title: 'Launch' })]
    })
    vi.setSystemTime(Date.now() + 31 * DAY_MS)
    await t.mutation(internal.ephemeris.retention.sweep, {})
    const after = await ana.query(api.ephemeris.sync.pull, { workspaceId: team, after: 2 })
    expect(after.changes).toEqual([expect.objectContaining({ table: 'recordings', recordId: 'r1', data: null, deviceId: 'retention' })])
  })
})

describe('billing', () => {
  const ENV = {
    EPHEMERIS_STRIPE_SECRET_KEY: 'sk_test_1',
    EPHEMERIS_STRIPE_WEBHOOK_SECRET: 'whsec_1',
    EPHEMERIS_STRIPE_PRICE_PRO_MONTHLY: 'price_pm',
    EPHEMERIS_STRIPE_PRICE_PRO_YEARLY: 'price_py',
    EPHEMERIS_STRIPE_PRICE_TEAM_MONTHLY: 'price_tm',
    EPHEMERIS_STRIPE_PRICE_TEAM_YEARLY: 'price_ty',
    EPHEMERIS_SITE_URL: 'https://ephemeris.app/'
  }

  it('reads its configuration and knows its prices', () => {
    expect(readStripeConfig({})).toBeNull()
    const c = readStripeConfig(ENV)!
    expect(c.siteUrl).toBe('https://ephemeris.app')
    expect(planForPrice(c, 'price_ty')).toBe('team')
    expect(planForPrice(c, 'price_pm')).toBe('pro')
    expect(planForPrice(c, 'price_other')).toBeNull()
    const params = checkoutSessionParams(c, { workspaceId: 'w1', plan: 'team', interval: 'year', seats: 7, email: 'a@b.c' })
    expect(params).toMatchObject({ line_items: { 0: { price: 'price_ty', quantity: 7 } }, metadata: { workspaceId: 'w1' } })
  })

  it('verifies webhook signatures', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' })
    const t = Math.floor(Date.now() / 1000)
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec_1'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))), (b) => b.toString(16).padStart(2, '0')).join('')
    await expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, 'whsec_1', Date.now())).resolves.toBeUndefined()
    await expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, 'whsec_2', Date.now())).rejects.toThrow()
    expect(parseStripeEvent({ id: 'e', type: 'invoice.paid' })).toEqual({ type: 'ignored', eventType: 'invoice.paid' })
  })

  it('applies a subscription to the workspace and ends it when Stripe does', async () => {
    for (const [k, val] of Object.entries(ENV)) vi.stubEnv(k, val)
    const { t, ana } = await setup()
    const team = await ana.mutation(api.ephemeris.workspaces.createTeam, { name: 'Acme' })
    const snapshot = { id: 'sub_1', status: 'active', priceId: 'price_tm', quantity: 9, customerId: 'cus_1', workspaceId: team }
    await t.mutation(internal.ephemeris.billing.applySubscription, { workspaceId: team, snapshot })
    let ws = (await ana.query(api.ephemeris.account.me, {}))!.workspaces.find((w) => w.kind === 'team')!
    expect(ws).toMatchObject({ plan: 'team', planState: 'active', trialEndsAt: null, billing: true })
    expect(ws.entitlements.seats).toBe(9)
    // An old subscription ending does nothing; the current one ending drops to Free.
    await t.mutation(internal.ephemeris.billing.applySubscription, { workspaceId: team, snapshot: { ...snapshot, id: 'sub_0', status: 'canceled' } })
    expect((await ana.query(api.ephemeris.account.me, {}))!.workspaces.find((w) => w.kind === 'team')!.planState).toBe('active')
    await t.mutation(internal.ephemeris.billing.applySubscription, { workspaceId: team, snapshot: { ...snapshot, status: 'canceled' } })
    ws = (await ana.query(api.ephemeris.account.me, {}))!.workspaces.find((w) => w.kind === 'team')!
    expect(ws.entitlements.plan).toBe('free')
    expect(await t.query(internal.ephemeris.billing.workspaceForCustomer, { customerId: 'cus_1' })).toBe(team)
  })

  it('refuses checkout when billing is not configured', async () => {
    const { ana, personal } = await setup()
    await expect(ana.action(api.ephemeris.billing.checkout, { workspaceId: personal, interval: 'month' })).rejects.toThrow(/Billing isn/)
  })
})
