import type { Plan } from './plans'

/**
 * The slice of Stripe Ephemeris uses, over plain `fetch` (the Convex runtime has fetch and Web
 * Crypto): Checkout for Pro and Team, the Customer Portal, and webhook verification. Team is billed
 * per seat, so a Team subscription's quantity is the workspace's seat count.
 *
 * Deployment variables:
 *
 *   STRIPE_SECRET_KEY            sk_test_â€¦ / sk_live_â€¦
 *   STRIPE_WEBHOOK_SECRET        whsec_â€¦ of the endpoint pointed at /stripe/webhook
 *   STRIPE_PRICE_PRO_MONTHLY     price_â€¦ Pro, per month
 *   STRIPE_PRICE_PRO_YEARLY      price_â€¦ Pro, per year
 *   STRIPE_PRICE_TEAM_MONTHLY    price_â€¦ Team, per seat per month
 *   STRIPE_PRICE_TEAM_YEARLY     price_â€¦ Team, per seat per year
 *   EPHEMERIS_SITE_URL           https://â€¦ where Checkout and the Portal return to (/account)
 */

export type Env = Record<string, string | undefined>
export type BillingInterval = 'month' | 'year'
export type PaidPlan = Extract<Plan, 'pro' | 'team'>

const STRIPE_API = 'https://api.stripe.com'
const SIGNATURE_TOLERANCE_SEC = 300





export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'StripeApiError'
  }
}

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StripeSignatureError'
  }
}

type FormValue = string | number | boolean | undefined
type FormParams = { [key: string]: FormValue | FormParams }

/** Stripe's nested form encoding: `{ line_items: [{ price }] }` becomes `line_items[0][price]=â€¦`. */
export function formEncode(params: FormParams, prefix = ''): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (value !== null && typeof value === 'object') {
      const nested = formEncode(value as FormParams, name)
      if (nested) parts.push(nested)
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.join('&')
}

/** One call to Stripe's REST API; errors carry Stripe's own message. */
export async function stripeRequest<T>(
  secretKey: string,
  method: 'GET' | 'POST',
  path: string,
  params?: FormParams
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` }
  let url = `${STRIPE_API}${path}`
  let body: string | undefined
  if (params && method === 'GET') url += `?${formEncode(params)}`
  else if (params) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = formEncode(params)
  }
  const res = await fetch(url, { method, headers, body })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new StripeApiError(`Stripe returned a malformed answer (HTTP ${res.status})`, res.status)
  }
  if (!res.ok) {
    const error = (json as { error?: { message?: string } }).error
    throw new StripeApiError(
      error?.message ?? `Stripe request failed (HTTP ${res.status})`,
      res.status
    )
  }
  return json as T
}

// ---- webhook signatures ------------------------------------------------------------------------

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Verify the `Stripe-Signature` header (`t=â€¦,v1=â€¦`): HMAC-SHA256 over `${t}.${payload}` with the
 * endpoint secret, within the replay tolerance. Throws `StripeSignatureError` otherwise.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowMs: number,
  toleranceSec = SIGNATURE_TOLERANCE_SEC
): Promise<void> {
  if (!header) throw new StripeSignatureError('Missing Stripe-Signature header')
  let timestamp = ''
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2)
    if (key === 't') timestamp = value ?? ''
    else if (key === 'v1' && value) signatures.push(value)
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0)
    throw new StripeSignatureError('Malformed Stripe-Signature header')
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > toleranceSec)
    throw new StripeSignatureError('Signature timestamp outside the tolerance window')
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const expected = hex(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`))
  )
  if (!signatures.some((sig) => timingSafeEqual(sig, expected)))
    throw new StripeSignatureError('Signature does not match')
}

// ---- configuration ----------------------------------------------------------------------------

export interface StripeConfig {
  secretKey: string
  webhookSecret: string | null
  prices: Record<PaidPlan, Record<BillingInterval, string>>
  siteUrl: string | null
}

const trimmed = (value: string | undefined): string => (value ?? '').trim()

/** Null unless the secret key and all four prices are set. */
export function readStripeConfig(env: Env): StripeConfig | null {
  const secretKey = trimmed(env.EPHEMERIS_STRIPE_SECRET_KEY)
  const prices = {
    pro: { month: trimmed(env.EPHEMERIS_STRIPE_PRICE_PRO_MONTHLY), year: trimmed(env.EPHEMERIS_STRIPE_PRICE_PRO_YEARLY) },
    team: { month: trimmed(env.EPHEMERIS_STRIPE_PRICE_TEAM_MONTHLY), year: trimmed(env.EPHEMERIS_STRIPE_PRICE_TEAM_YEARLY) }
  }
  if (!secretKey || !prices.pro.month || !prices.pro.year || !prices.team.month || !prices.team.year)
    return null
  const site = trimmed(env.EPHEMERIS_SITE_URL).replace(/\/+$/, '')
  return {
    secretKey,
    webhookSecret: trimmed(env.EPHEMERIS_STRIPE_WEBHOOK_SECRET) || null,
    prices,
    siteUrl: /^https?:\/\//i.test(site) ? site : null
  }
}

/** Which plan a price id is, or null for a price Ephemeris doesn't sell. */
export function planForPrice(config: StripeConfig, priceId: string): PaidPlan | null {
  for (const plan of ['pro', 'team'] as const)
    if (config.prices[plan].month === priceId || config.prices[plan].year === priceId) return plan
  return null
}

// ---- events -----------------------------------------------------------------------------------

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused'

const STATUSES: ReadonlySet<string> = new Set<SubscriptionStatus>([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused'
])

/** What a workspace keeps of a subscription. */
export interface SubscriptionSnapshot {
  id: string
  status: SubscriptionStatus
  priceId: string
  quantity: number
  customerId: string | null
  workspaceId: string | null
}

const idOf = (value: string | { id?: string } | undefined | null): string | null =>
  typeof value === 'string' ? value : (value?.id ?? null)

export function subscriptionSnapshot(raw: unknown): SubscriptionSnapshot | null {
  const sub = (raw ?? {}) as {
    id?: string
    status?: string
    customer?: string | { id?: string }
    metadata?: Record<string, string>
    items?: { data?: Array<{ quantity?: number; price?: { id?: string } }> }
  }
  if (!sub.id || !sub.status || !STATUSES.has(sub.status)) return null
  const item = sub.items?.data?.[0]
  if (!item?.price?.id) return null
  return {
    id: sub.id,
    status: sub.status as SubscriptionStatus,
    priceId: item.price.id,
    quantity: Math.max(1, item.quantity ?? 1),
    customerId: idOf(sub.customer),
    workspaceId: sub.metadata?.workspaceId || null
  }
}

/** The workspace's plan state for a subscription status. */
export function planStateFor(status: SubscriptionStatus): 'active' | 'past_due' | 'canceled' {
  if (status === 'active' || status === 'trialing') return 'active'
  if (status === 'past_due' || status === 'unpaid' || status === 'incomplete') return 'past_due'
  return 'canceled'
}

export type StripeEvent =
  | { type: 'checkout.session.completed'; id: string; workspaceId: string | null; customerId: string | null; subscriptionId: string | null }
  | { type: 'customer.subscription.updated' | 'customer.subscription.deleted'; id: string; subscription: SubscriptionSnapshot }
  | { type: 'ignored'; eventType: string }

export function parseStripeEvent(body: unknown): StripeEvent {
  const event = (body ?? {}) as { id?: string; type?: string; data?: { object?: Record<string, unknown> } }
  const type = event.type ?? ''
  const id = event.id ?? ''
  const object = event.data?.object ?? {}
  if (!id) return { type: 'ignored', eventType: type }
  if (type === 'checkout.session.completed') {
    const s = object as {
      mode?: string
      customer?: string | { id?: string }
      subscription?: string | { id?: string }
      client_reference_id?: string | null
      metadata?: Record<string, string>
    }
    if (s.mode !== 'subscription') return { type: 'ignored', eventType: type }
    return {
      type,
      id,
      workspaceId: s.metadata?.workspaceId || s.client_reference_id || null,
      customerId: idOf(s.customer),
      subscriptionId: idOf(s.subscription)
    }
  }
  if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    const subscription = subscriptionSnapshot(object)
    if (!subscription) return { type: 'ignored', eventType: type }
    return { type, id, subscription }
  }
  return { type: 'ignored', eventType: type }
}

// ---- sessions ---------------------------------------------------------------------------------

export function checkoutSessionParams(
  config: StripeConfig,
  input: { workspaceId: string; plan: PaidPlan; interval: BillingInterval; seats: number; email: string; customerId?: string }
): FormParams {
  const site = config.siteUrl ?? ''
  return {
    mode: 'subscription',
    line_items: { 0: { price: config.prices[input.plan][input.interval], quantity: input.plan === 'team' ? Math.max(1, input.seats) : 1 } },
    client_reference_id: input.workspaceId,
    customer: input.customerId,
    customer_email: input.customerId ? undefined : input.email || undefined,
    success_url: `${site}/account?checkout=success`,
    cancel_url: `${site}/account?checkout=cancelled`,
    allow_promotion_codes: true,
    metadata: { workspaceId: input.workspaceId },
    subscription_data: { metadata: { workspaceId: input.workspaceId } }
  }
}

export function portalSessionParams(config: StripeConfig, customerId: string): FormParams {
  return { customer: customerId, return_url: `${config.siteUrl ?? ''}/account` }
}
