import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../convex/_generated/api'
import {
  DEFAULT_MIC_ICE_SERVERS,
  MIC_MAX_PENDING,
  MIC_RECEIVER_STALE_MS,
  MIC_SIGNAL_TTL_MS,
  iceServersFromEnv,
  parseDesktopMessage,
  parsePhoneMessage,
  resultMessage,
  routeOf,
  tuneOpusSdp
} from '../convex/lib/micProtocol'
import { ada, bob, setup } from './helpers'

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'

async function signalCount(t: ReturnType<typeof setup>): Promise<number> {
  return await t.run(async (ctx) => (await ctx.db.query('micSignals').collect()).length)
}

afterEach(() => {
  vi.useRealTimers()
  delete process.env.MURMUR_MIC_ICE_SERVERS
})

describe('micLink signaling', () => {
  it('stops listing a desktop its heartbeat has not seen lately', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const heartbeat = (deviceId: string) =>
      asAda.mutation(api.devices.heartbeat, {
        deviceId,
        name: deviceId,
        platform: 'linux',
        appVersion: '1.0.0'
      })
    await heartbeat('desk-live')
    await heartbeat('desk-gone')
    await asAda.mutation(api.micLink.register, {
      deviceId: 'desk-live',
      name: 'Live',
      platform: 'linux'
    })
    await asAda.mutation(api.micLink.register, {
      deviceId: 'desk-gone',
      name: 'Gone',
      platform: 'linux'
    })
    expect((await asAda.query(api.micLink.receivers, {})).receivers).toHaveLength(2)

    // An hour on, only the desktop that kept its heartbeat going is listed and reachable.
    vi.setSystemTime(Date.now() + MIC_RECEIVER_STALE_MS + 15 * 60_000)
    await heartbeat('desk-live')
    expect((await asAda.query(api.micLink.receivers, {})).receivers.map((r) => r.deviceId)).toEqual(
      ['desk-live']
    )
    await expect(
      asAda.mutation(api.micLink.offer, {
        to: 'desk-gone',
        from: 'p',
        fromName: 'P',
        linkId: 'l',
        sdp: SDP
      })
    ).rejects.toThrow(/not_listening/)
    await asAda.mutation(api.micLink.offer, {
      to: 'desk-live',
      from: 'p',
      fromName: 'P',
      linkId: 'l',
      sdp: SDP
    })
  })

  it('removing a device or deleting the account leaves no phone-microphone rows', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const asBob = t.withIdentity(bob)
    for (const as of [asAda, asBob]) {
      await as.mutation(api.devices.heartbeat, {
        deviceId: 'desk-1',
        name: 'D',
        platform: 'linux',
        appVersion: '1.0.0'
      })
      await as.mutation(api.micLink.register, { deviceId: 'desk-1', name: 'D', platform: 'linux' })
      await as.mutation(api.micLink.offer, {
        to: 'desk-1',
        from: 'p',
        fromName: 'P',
        linkId: 'l',
        sdp: SDP
      })
    }
    const count = (table: 'micReceivers' | 'micSignals') =>
      t.run(async (ctx) => (await ctx.db.query(table).collect()).length)
    expect([await count('micReceivers'), await count('micSignals')]).toEqual([2, 2])

    expect(await asAda.mutation(api.devices.remove, { deviceId: 'desk-1' })).toBe(true)
    expect([await count('micReceivers'), await count('micSignals')]).toEqual([1, 1])

    await asBob.mutation(api.users.deleteMyData, {})
    expect([await count('micReceivers'), await count('micSignals')]).toEqual([0, 0])
  })

  it('runs one offer and one answer and leaves no rows behind', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const reg = await asAda.mutation(api.micLink.register, {
      deviceId: 'desk-1',
      name: 'Ada laptop',
      platform: 'linux'
    })
    expect(reg.iceServers).toEqual(DEFAULT_MIC_ICE_SERVERS)

    const listed = await asAda.query(api.micLink.receivers, {})
    expect(listed.receivers.map((r) => r.deviceId)).toEqual(['desk-1'])

    const { id: offerId } = await asAda.mutation(api.micLink.offer, {
      to: 'desk-1',
      from: 'phone-1',
      fromName: 'Pixel',
      linkId: 'link-1',
      sdp: SDP + 'a=offer\r\n'
    })
    const deskInbox = await asAda.query(api.micLink.inbox, { deviceId: 'desk-1' })
    expect(deskInbox).toHaveLength(1)
    expect(deskInbox[0]).toMatchObject({
      id: offerId,
      kind: 'offer',
      from: 'phone-1',
      linkId: 'link-1'
    })

    expect(
      await asAda.mutation(api.micLink.answer, {
        offerId,
        fromName: 'Ada laptop',
        sdp: SDP + 'a=answer\r\n'
      })
    ).toBe(true)
    expect(await asAda.query(api.micLink.inbox, { deviceId: 'desk-1' })).toEqual([])
    const phoneInbox = await asAda.query(api.micLink.inbox, { deviceId: 'phone-1' })
    expect(phoneInbox).toHaveLength(1)
    expect(phoneInbox[0]).toMatchObject({
      kind: 'answer',
      from: 'desk-1',
      fromName: 'Ada laptop',
      linkId: 'link-1'
    })
    expect(phoneInbox[0].sdp).toContain('a=answer')

    expect(await asAda.mutation(api.micLink.take, { id: phoneInbox[0].id })).toBe(true)
    expect(await signalCount(t)).toBe(0)
  })

  it('refuses offers to a desktop that is not listening, and to itself', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await expect(
      asAda.mutation(api.micLink.offer, {
        to: 'desk-1',
        from: 'phone-1',
        fromName: 'P',
        linkId: 'l',
        sdp: SDP
      })
    ).rejects.toThrow(/not_listening/)
    await asAda.mutation(api.micLink.register, {
      deviceId: 'desk-1',
      name: 'Laptop',
      platform: 'win32'
    })
    await expect(
      asAda.mutation(api.micLink.offer, {
        to: 'desk-1',
        from: 'desk-1',
        fromName: 'P',
        linkId: 'l',
        sdp: SDP
      })
    ).rejects.toThrow(/itself/)
    await expect(
      asAda.mutation(api.micLink.offer, {
        to: 'desk-1',
        from: 'p',
        fromName: 'P',
        linkId: 'l',
        sdp: 'nope'
      })
    ).rejects.toThrow(/session description/)
    await expect(
      asAda.mutation(api.micLink.offer, {
        to: 'desk-1',
        from: 'p',
        fromName: 'P',
        linkId: 'l',
        sdp: SDP + 'a='.padEnd(20_000, 'x')
      })
    ).rejects.toThrow(/too long/)
  })

  it('keeps accounts apart', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    const asBob = t.withIdentity(bob)
    await asAda.mutation(api.micLink.register, {
      deviceId: 'desk-1',
      name: 'Laptop',
      platform: 'darwin'
    })
    // Bob cannot see Ada's desktop, cannot offer to it, cannot read or answer its inbox.
    expect((await asBob.query(api.micLink.receivers, {})).receivers).toEqual([])
    await expect(
      asBob.mutation(api.micLink.offer, {
        to: 'desk-1',
        from: 'bob-phone',
        fromName: 'B',
        linkId: 'l',
        sdp: SDP
      })
    ).rejects.toThrow(/not_listening/)
    const { id } = await asAda.mutation(api.micLink.offer, {
      to: 'desk-1',
      from: 'ada-phone',
      fromName: 'A',
      linkId: 'l',
      sdp: SDP
    })
    expect(await asBob.query(api.micLink.inbox, { deviceId: 'desk-1' })).toEqual([])
    expect(await asBob.mutation(api.micLink.answer, { offerId: id, fromName: 'x', sdp: SDP })).toBe(
      false
    )
    expect(await asBob.mutation(api.micLink.take, { id })).toBe(false)
    expect(await signalCount(t)).toBe(1)
  })

  it('declines with a reason', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.micLink.register, {
      deviceId: 'desk-1',
      name: 'Laptop',
      platform: 'linux'
    })
    const { id } = await asAda.mutation(api.micLink.offer, {
      to: 'desk-1',
      from: 'phone-1',
      fromName: 'P',
      linkId: 'l',
      sdp: SDP
    })
    await asAda.mutation(api.micLink.answer, {
      offerId: id,
      fromName: 'Laptop',
      reason: 'Dictation is turned off'
    })
    const [decline] = await asAda.query(api.micLink.inbox, { deviceId: 'phone-1' })
    expect(decline).toMatchObject({ kind: 'decline', sdp: '', reason: 'Dictation is turned off' })
  })

  it('bounds pending offers and sweeps expired ones', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.micLink.register, {
      deviceId: 'desk-1',
      name: 'Laptop',
      platform: 'linux'
    })
    for (let i = 0; i < MIC_MAX_PENDING + 3; i++) {
      vi.advanceTimersByTime(1000)
      await asAda.mutation(api.micLink.offer, {
        to: 'desk-1',
        from: 'p',
        fromName: 'P',
        linkId: `l${i}`,
        sdp: SDP
      })
    }
    const inbox = await asAda.query(api.micLink.inbox, { deviceId: 'desk-1' })
    expect(inbox.map((s) => s.linkId)).toEqual(['l3', 'l4', 'l5', 'l6'])

    // Past the TTL the inbox hides them, and the next write removes them.
    vi.advanceTimersByTime(MIC_SIGNAL_TTL_MS + 1)
    expect(await asAda.query(api.micLink.inbox, { deviceId: 'desk-1' })).toEqual([])
    await asAda.mutation(api.micLink.offer, {
      to: 'desk-1',
      from: 'p',
      fromName: 'P',
      linkId: 'new',
      sdp: SDP
    })
    expect(await signalCount(t)).toBe(1)
    // An answer to an expired offer is not sent.
    const [fresh] = await asAda.query(api.micLink.inbox, { deviceId: 'desk-1' })
    vi.advanceTimersByTime(MIC_SIGNAL_TTL_MS + 1)
    expect(
      await asAda.mutation(api.micLink.answer, { offerId: fresh.id, fromName: 'L', sdp: SDP })
    ).toBe(false)
    expect(await signalCount(t)).toBe(0)
  })

  it('writes the receiver row only when something changed or a day passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
    const t = setup()
    const asAda = t.withIdentity(ada)
    const args = { deviceId: 'desk-1', name: 'Laptop', platform: 'linux' as const }
    await asAda.mutation(api.micLink.register, args)
    const first = await t.run(async (ctx) => (await ctx.db.query('micReceivers').first())!)
    vi.advanceTimersByTime(60_000)
    await asAda.mutation(api.micLink.register, args)
    const same = await t.run(async (ctx) => (await ctx.db.query('micReceivers').first())!)
    expect(same._creationTime).toBe(first._creationTime)
    expect(same.registeredAt).toBe(first.registeredAt)
    await asAda.mutation(api.micLink.register, { ...args, name: 'Renamed' })
    const renamed = await t.run(async (ctx) => (await ctx.db.query('micReceivers').first())!)
    expect(renamed.name).toBe('Renamed')
    expect(renamed.registeredAt).toBeGreaterThan(first.registeredAt)

    expect(await asAda.mutation(api.micLink.unregister, { deviceId: 'desk-1' })).toBe(true)
    expect((await asAda.query(api.micLink.receivers, {})).receivers).toEqual([])
    expect(await asAda.mutation(api.micLink.unregister, { deviceId: 'desk-1' })).toBe(false)
  })

  it('clears a desktop inbox when it stops listening', async () => {
    const t = setup()
    const asAda = t.withIdentity(ada)
    await asAda.mutation(api.micLink.register, {
      deviceId: 'desk-1',
      name: 'Laptop',
      platform: 'linux'
    })
    await asAda.mutation(api.micLink.offer, {
      to: 'desk-1',
      from: 'p',
      fromName: 'P',
      linkId: 'l',
      sdp: SDP
    })
    await asAda.mutation(api.micLink.unregister, { deviceId: 'desk-1' })
    expect(await signalCount(t)).toBe(0)
  })

  it('serves configured ICE servers', async () => {
    process.env.MURMUR_MIC_ICE_SERVERS = JSON.stringify([
      { urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' }
    ])
    const t = setup()
    const res = await t.withIdentity(ada).query(api.micLink.receivers, {})
    expect(res.iceServers).toEqual([
      { urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' }
    ])
  })
})

describe('micProtocol', () => {
  it('reads ICE server configuration defensively', () => {
    expect(iceServersFromEnv(undefined)).toEqual(DEFAULT_MIC_ICE_SERVERS)
    expect(iceServersFromEnv('not json')).toEqual(DEFAULT_MIC_ICE_SERVERS)
    expect(iceServersFromEnv('{}')).toEqual(DEFAULT_MIC_ICE_SERVERS)
    expect(iceServersFromEnv('[{"urls":5},{"nope":1}]')).toEqual(DEFAULT_MIC_ICE_SERVERS)
    expect(iceServersFromEnv('[{"urls":["stun:a","stun:b"],"username":1}]')).toEqual([
      { urls: ['stun:a', 'stun:b'] }
    ])
  })

  it('tunes Opus for speech and keeps other parameters', () => {
    const sdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=0;stereo=1',
      'a=rtpmap:63 red/48000/2',
      'a=fmtp:63 111/111',
      ''
    ].join('\r\n')
    const tuned = tuneOpusSdp(sdp)
    expect(tuned).toContain(
      'a=fmtp:111 minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;usedtx=0;maxaveragebitrate=32000'
    )
    expect(tuned).toContain('a=fmtp:63 111/111')
    expect(tuned.split('\r\n')).toHaveLength(sdp.split('\r\n').length)
    // Idempotent, and an Opus payload without fmtp gets one.
    expect(tuneOpusSdp(tuned)).toBe(tuned)
    const bare = tuneOpusSdp('v=0\na=rtpmap:96 opus/48000/2\n')
    expect(bare).toBe(
      'v=0\na=rtpmap:96 opus/48000/2\na=fmtp:96 stereo=0;sprop-stereo=0;useinbandfec=1;usedtx=0;maxaveragebitrate=32000\n'
    )
    expect(tuneOpusSdp('v=0\r\n')).toBe('v=0\r\n')
  })

  it('parses control messages strictly', () => {
    expect(parsePhoneMessage('{"t":"start"}')).toEqual({ t: 'start' })
    expect(parsePhoneMessage({ t: 'hello', v: 1, name: 'Pixel' })).toEqual({
      t: 'hello',
      v: 1,
      name: 'Pixel'
    })
    expect(parsePhoneMessage('{"t":"rm -rf"}')).toBeNull()
    expect(parsePhoneMessage('nope')).toBeNull()
    expect(parsePhoneMessage('[1]')).toBeNull()
    expect(parsePhoneMessage('x'.repeat(5000))).toBeNull()
    expect(parseDesktopMessage({ t: 'state', state: 'listening', elapsedSec: 3 })).toEqual({
      t: 'state',
      state: 'listening',
      elapsedSec: 3
    })
    expect(parseDesktopMessage({ t: 'state', state: 'weird' })).toBeNull()
    expect(parseDesktopMessage({ t: 'level', level: 7 })).toEqual({ t: 'level', level: 1 })
    expect(
      parseDesktopMessage({ t: 'welcome', v: 1, name: 'Laptop', state: 'idle' })
    ).toMatchObject({
      t: 'welcome'
    })
  })

  it('previews results and names routes', () => {
    expect(resultMessage('  hello there world ')).toEqual({
      t: 'result',
      text: 'hello there world',
      words: 3
    })
    const long = resultMessage('word '.repeat(200))
    expect(long.t === 'result' && long.text.length).toBe(280)
    expect(long.t === 'result' && long.words).toBe(200)
    expect(routeOf('host', 'host')).toBe('direct')
    expect(routeOf('srflx', 'host')).toBe('stun')
    expect(routeOf('host', 'relay')).toBe('relay')
    expect(routeOf(undefined, 'host')).toBe('unknown')
  })
})
