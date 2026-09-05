import { Webhook } from 'svix'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../convex/_generated/api'
import { parseClerkEvent, verifyClerkWebhook } from '../convex/lib/clerkWebhook'
import { setup } from './helpers'

const SECRET = 'whsec_dGVzdHNlY3JldHRlc3RzZWNyZXQ='

function sign(payload: string, secret = SECRET): Record<string, string> {
  const id = 'msg_test'
  const timestamp = new Date()
  const signature = new Webhook(secret).sign(id, timestamp, payload)
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'svix-signature': signature
  }
}

const userCreated = {
  type: 'user.created',
  data: {
    id: 'user_hook',
    first_name: 'Grace',
    last_name: 'Hopper',
    image_url: 'https://img.clerk.com/grace.png',
    primary_email_address_id: 'em_2',
    email_addresses: [
      { id: 'em_1', email_address: 'old@example.com' },
      { id: 'em_2', email_address: 'grace@example.com' }
    ]
  }
}

describe('clerk webhook parsing', () => {
  it('extracts the primary email and full name', () => {
    expect(parseClerkEvent(userCreated)).toEqual({
      type: 'user.created',
      clerkId: 'user_hook',
      email: 'grace@example.com',
      name: 'Grace Hopper',
      imageUrl: 'https://img.clerk.com/grace.png'
    })
    expect(parseClerkEvent({ type: 'user.deleted', data: { id: 'user_hook' } })).toEqual({
      type: 'user.deleted',
      clerkId: 'user_hook'
    })
    expect(parseClerkEvent({ type: 'session.created', data: { id: 'sess_1' } })).toEqual({
      type: 'ignored',
      eventType: 'session.created'
    })
    expect(parseClerkEvent(null)).toEqual({ type: 'ignored', eventType: '' })
  })

  it('verifies signatures', () => {
    const payload = JSON.stringify(userCreated)
    const headers = sign(payload)
    const event = verifyClerkWebhook(
      payload,
      {
        id: headers['svix-id'],
        timestamp: headers['svix-timestamp'],
        signature: headers['svix-signature']
      },
      SECRET
    )
    expect(event.type).toBe('user.created')
    expect(() =>
      verifyClerkWebhook(
        payload,
        {
          id: headers['svix-id'],
          timestamp: headers['svix-timestamp'],
          signature: 'v1,bogus'
        },
        SECRET
      )
    ).toThrow(/signature/i)
    expect(() =>
      verifyClerkWebhook(payload, { id: null, timestamp: null, signature: null }, SECRET)
    ).toThrow(/Missing Svix headers/)
  })
})

describe('POST /clerk/webhook', () => {
  beforeEach(() => vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET', SECRET))
  afterEach(() => vi.unstubAllEnvs())

  it('creates, updates and purges users', async () => {
    const t = setup()
    const created = JSON.stringify(userCreated)
    const res = await t.fetch('/clerk/webhook', { method: 'POST', headers: sign(created), body: created })
    expect(res.status).toBe(200)
    const asGrace = t.withIdentity({ subject: 'user_hook' })
    expect(await asGrace.query(api.users.me, {})).toMatchObject({
      email: 'grace@example.com',
      name: 'Grace Hopper'
    })

    const updated = JSON.stringify({
      ...userCreated,
      type: 'user.updated',
      data: { ...userCreated.data, first_name: 'Grace B.', email_addresses: [] }
    })
    expect(
      (await t.fetch('/clerk/webhook', { method: 'POST', headers: sign(updated), body: updated }))
        .status
    ).toBe(200)
    expect(await asGrace.query(api.users.me, {})).toMatchObject({
      email: 'grace@example.com',
      name: 'Grace B. Hopper'
    })

    await asGrace.mutation(api.dictionary.upsert, { word: 'COBOL' })
    const deleted = JSON.stringify({ type: 'user.deleted', data: { id: 'user_hook' } })
    expect(
      (await t.fetch('/clerk/webhook', { method: 'POST', headers: sign(deleted), body: deleted }))
        .status
    ).toBe(200)
    expect(await asGrace.query(api.users.me, {})).toBeNull()
    await t.run(async (ctx) => {
      expect(await ctx.db.query('dictionaryEntries').collect()).toHaveLength(0)
    })
  })

  it('rejects bad signatures and unrelated events are acknowledged', async () => {
    const t = setup()
    const payload = JSON.stringify(userCreated)
    const forged = await t.fetch('/clerk/webhook', {
      method: 'POST',
      headers: sign(payload, 'whsec_d3Jvbmd3cm9uZ3dyb25nd3Jvbmc='),
      body: payload
    })
    expect(forged.status).toBe(400)
    const missing = await t.fetch('/clerk/webhook', { method: 'POST', body: payload })
    expect(missing.status).toBe(400)

    const other = JSON.stringify({ type: 'session.created', data: { id: 'sess_1' } })
    expect(
      (await t.fetch('/clerk/webhook', { method: 'POST', headers: sign(other), body: other })).status
    ).toBe(200)
    await t.run(async (ctx) => {
      expect(await ctx.db.query('users').collect()).toHaveLength(0)
    })
  })

  it('fails closed when the signing secret is not configured', async () => {
    vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET', '')
    const t = setup()
    const payload = JSON.stringify(userCreated)
    const res = await t.fetch('/clerk/webhook', { method: 'POST', headers: sign(payload), body: payload })
    expect(res.status).toBe(500)
  })
})
