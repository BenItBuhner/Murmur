import { Webhook } from 'svix'

/** The subset of Clerk's webhook payload Murmur acts on. */
export type ClerkUserEvent =
  | {
      type: 'user.created' | 'user.updated'
      clerkId: string
      email?: string
      name?: string
      imageUrl?: string
    }
  | { type: 'user.deleted'; clerkId: string }
  | { type: 'ignored'; eventType: string }

interface ClerkEmailAddress {
  id?: string
  email_address?: string
}

interface ClerkUserPayload {
  type?: string
  data?: {
    id?: string
    first_name?: string | null
    last_name?: string | null
    image_url?: string | null
    primary_email_address_id?: string | null
    email_addresses?: ClerkEmailAddress[]
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookVerificationError'
  }
}

/** Verify the Svix signature Clerk puts on every delivery and return the parsed event. */
export function verifyClerkWebhook(
  payload: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  signingSecret: string
): ClerkUserEvent {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    throw new WebhookVerificationError('Missing Svix headers')
  }
  try {
    // svix v2 only throws on failure; the payload must be parsed by the caller once it is trusted.
    new Webhook(signingSecret).verify(payload, {
      'svix-id': headers.id,
      'svix-timestamp': headers.timestamp,
      'svix-signature': headers.signature
    })
  } catch (err) {
    throw new WebhookVerificationError(err instanceof Error ? err.message : 'Invalid signature')
  }
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new WebhookVerificationError('Payload is not JSON')
  }
  return parseClerkEvent(body)
}

export function parseClerkEvent(body: unknown): ClerkUserEvent {
  const event = (body ?? {}) as ClerkUserPayload
  const type = event.type ?? ''
  const id = event.data?.id
  if (!id) return { type: 'ignored', eventType: type }
  if (type === 'user.deleted') return { type, clerkId: id }
  if (type === 'user.created' || type === 'user.updated') {
    const data = event.data ?? {}
    const emails = data.email_addresses ?? []
    const primary =
      emails.find((e) => e.id && e.id === data.primary_email_address_id)?.email_address ??
      emails[0]?.email_address
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ').trim()
    return {
      type,
      clerkId: id,
      email: primary || undefined,
      name: name || undefined,
      imageUrl: data.image_url || undefined
    }
  }
  return { type: 'ignored', eventType: type }
}
