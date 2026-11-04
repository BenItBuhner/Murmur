import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { getFunctionName } from 'convex/server'
import {
  MIC_DROP_GRACE_MS,
  parseDesktopMessage,
  type DesktopToPhone
} from '@backend/lib/micProtocol'
import type { PhoneMicOfferMessage, PhoneMicStatus } from '@shared/ipc'
import {
  PhoneMicHost,
  type CloudSource,
  type DictationSource,
  type InboxSignal,
  type SignalingClient
} from '../src/main/phone-mic/host'

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

class FakeClient {
  calls: Array<{ name: string; args: Record<string, unknown> }> = []
  inboxCb: ((s: InboxSignal[]) => void) | null = null
  subscriptions = 0
  unsubscribed = 0
  registerResult: Promise<{ iceServers: unknown[] }> = Promise.resolve({
    iceServers: [{ urls: 'stun:x' }]
  })

  onUpdate(_q: unknown, _args: unknown, cb: (s: InboxSignal[]) => void): () => void {
    this.subscriptions++
    this.inboxCb = cb
    return () => {
      this.unsubscribed++
      this.inboxCb = null
    }
  }

  mutation(ref: unknown, args: Record<string, unknown>): Promise<unknown> {
    const name = getFunctionName(ref as never)
    this.calls.push({ name, args })
    if (name === 'micLink:register') return this.registerResult
    return Promise.resolve(true)
  }

  names(): string[] {
    return this.calls.map((c) => c.name)
  }
}

class FakeCloud extends EventEmitter {
  client: FakeClient | null = new FakeClient()
  get authedClient(): SignalingClient | null {
    return this.client as unknown as SignalingClient | null
  }
  deviceIdentity = { deviceId: 'desk-1', name: 'Laptop', platform: 'linux' as const }
}

class FakeDictation extends EventEmitter {
  enabled = true
  isListening = false
  isBusy = false
  toggles = 0
  cancels = 0
  toggle(): void {
    this.toggles++
    this.isListening = !this.isListening
    this.emit('state', this.isListening ? 'listening' : 'processing')
  }
  handle(): void {
    this.cancels++
    this.isListening = false
    this.emit('state', 'idle')
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function offer(id: string, linkId: string, createdAt = Date.now()): InboxSignal {
  return {
    id: id as InboxSignal['id'],
    kind: 'offer',
    from: 'phone-1',
    fromName: 'Pixel',
    linkId,
    sdp: 'v=0 offer',
    createdAt
  }
}

interface Env {
  host: PhoneMicHost
  cloud: FakeCloud
  dictation: FakeDictation
  levels: EventEmitter
  sent: Array<{ linkId: string; m: DesktopToPhone }>
  offers: PhoneMicOfferMessage[]
  closed: string[]
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>
  statuses: PhoneMicStatus[]
  setEnabled: (v: boolean) => void
  advance: (ms: number) => number
}

function setup(opts: { enabled?: boolean } = {}): Env {
  let enabled = opts.enabled ?? true
  const settingsListeners = new Set<() => void>()
  const cloud = new FakeCloud()
  const dictation = new FakeDictation()
  const levels = new EventEmitter()
  const sent: Array<{ linkId: string; m: DesktopToPhone }> = []
  const offers: PhoneMicOfferMessage[] = []
  const closed: string[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  let now = 1_000_000
  const host = new PhoneMicHost({
    enabled: () => enabled,
    onSettingsChange: (cb) => {
      settingsListeners.add(cb)
      return () => settingsListeners.delete(cb)
    },
    cloud: cloud as unknown as CloudSource,
    dictation: dictation as unknown as DictationSource,
    levels,
    overlay: {
      offer: (m) => offers.push(m),
      send: (linkId, m) => sent.push({ linkId, m }),
      close: (linkId) => closed.push(linkId)
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      ;(t as { cleared: boolean }).cleared = true
    }
  })
  const statuses: PhoneMicStatus[] = []
  host.on('status', (s: PhoneMicStatus) => statuses.push(s))
  return {
    host,
    cloud,
    dictation,
    levels,
    sent,
    offers,
    closed,
    timers,
    statuses,
    setEnabled: (v: boolean) => {
      enabled = v
      settingsListeners.forEach((cb) => cb())
    },
    advance: (ms: number) => (now += ms)
  }
}

/** Runs an offer through to an open, connected link. */
async function linked(env: Env): Promise<void> {
  env.host.start()
  await flush()
  env.cloud.client!.inboxCb!([offer('o1', 'link-1', 1_000_000)])
  env.host.onAnswer({ offerId: 'o1', linkId: 'link-1', sdp: 'v=0 answer' })
  await flush()
  env.host.onEvent({ linkId: 'link-1', type: 'state', state: 'connected', route: 'direct' })
  env.host.onEvent({ linkId: 'link-1', type: 'open' })
}

describe('PhoneMicHost', () => {
  it('does nothing at all while the switch is off', async () => {
    const env = setup({ enabled: false })
    env.host.start()
    await flush()
    expect(env.cloud.client!.calls).toEqual([])
    expect(env.cloud.client!.subscriptions).toBe(0)
    expect(env.host.getStatus()).toEqual({ enabled: false, state: 'off' })
  })

  it('registers once and holds one inbox subscription while on', async () => {
    const env = setup()
    env.host.start()
    await flush()
    expect(env.cloud.client!.names()).toEqual(['micLink:register'])
    expect(env.cloud.client!.calls[0].args).toEqual({
      deviceId: 'desk-1',
      name: 'Laptop',
      platform: 'linux'
    })
    expect(env.cloud.client!.subscriptions).toBe(1)
    expect(env.host.getStatus().state).toBe('waiting')
    // Status churn from the account connection does not re-register.
    env.cloud.emit('status')
    env.cloud.emit('status')
    await flush()
    expect(env.cloud.client!.names()).toEqual(['micLink:register'])
    expect(env.cloud.client!.subscriptions).toBe(1)
  })

  it('unregisters and drops the subscription when switched off', async () => {
    const env = setup()
    env.host.start()
    await flush()
    env.setEnabled(false)
    await flush()
    expect(env.cloud.client!.names()).toEqual(['micLink:register', 'micLink:unregister'])
    expect(env.cloud.client!.unsubscribed).toBe(1)
    expect(env.host.getStatus().state).toBe('off')
  })

  it('re-registers after the account connection comes back, and on a rename', async () => {
    const env = setup()
    env.host.start()
    await flush()
    const client = env.cloud.client!
    env.cloud.client = null
    env.cloud.emit('status')
    expect(client.unsubscribed).toBe(1)
    expect(env.host.getStatus().state).toBe('offline')
    env.cloud.client = client
    env.cloud.emit('status')
    await flush()
    expect(client.names()).toEqual(['micLink:register', 'micLink:register'])
    expect(env.host.getStatus().state).toBe('waiting')
    env.cloud.deviceIdentity = { ...env.cloud.deviceIdentity, name: 'Renamed' }
    env.setEnabled(true)
    await flush()
    expect(client.calls.at(-1)).toEqual({
      name: 'micLink:register',
      args: { deviceId: 'desk-1', name: 'Renamed', platform: 'linux' }
    })
  })

  it('answers an offer through the overlay and greets the phone when the channel opens', async () => {
    const env = setup()
    await linked(env)
    expect(env.offers).toEqual([
      {
        offerId: 'o1',
        linkId: 'link-1',
        phoneName: 'Pixel',
        sdp: 'v=0 offer',
        iceServers: [{ urls: 'stun:x' }]
      }
    ])
    expect(env.cloud.client!.calls.at(-1)).toEqual({
      name: 'micLink:answer',
      args: { offerId: 'o1', fromName: 'Laptop', sdp: 'v=0 answer' }
    })
    expect(env.sent.map((s) => s.m)).toEqual([
      { t: 'welcome', v: 1, name: 'Laptop', state: 'idle' }
    ])
    expect(env.host.getStatus()).toEqual({
      enabled: true,
      state: 'connected',
      phoneName: 'Pixel',
      route: 'direct'
    })
    // The same offer seen again (the inbox re-runs) is not answered twice.
    env.cloud.client!.inboxCb!([offer('o1', 'link-1')])
    expect(env.offers).toHaveLength(1)
  })

  it('declines when dictation is paused, and when the overlay cannot answer', async () => {
    const env = setup()
    env.host.start()
    await flush()
    env.dictation.enabled = false
    env.cloud.client!.inboxCb!([offer('o1', 'l1', 1_000_000)])
    await flush()
    expect(env.offers).toEqual([])
    expect(env.cloud.client!.calls.at(-1)?.args).toMatchObject({
      offerId: 'o1',
      reason: expect.stringMatching(/paused/)
    })

    env.dictation.enabled = true
    env.cloud.client!.inboxCb!([offer('o2', 'l2', 1_000_000)])
    env.host.onAnswer({ offerId: 'o2', linkId: 'l2', error: 'no audio' })
    await flush()
    expect(env.cloud.client!.calls.at(-1)?.args).toEqual({
      offerId: 'o2',
      fromName: 'Laptop',
      reason: 'no audio'
    })
    expect(env.host.getStatus().state).toBe('waiting')
  })

  it('lets the phone start, stop and cancel the dictation, and reports back', async () => {
    const env = setup()
    await linked(env)
    env.sent.length = 0
    env.host.onEvent({ linkId: 'link-1', type: 'message', data: '{"t":"start"}' })
    expect(env.dictation.toggles).toBe(1)
    expect(env.sent.map((s) => s.m)).toEqual([{ t: 'state', state: 'listening' }])
    // A second start while listening is ignored.
    env.host.onEvent({ linkId: 'link-1', type: 'message', data: '{"t":"start"}' })
    expect(env.dictation.toggles).toBe(1)

    env.levels.emit('level', 0.5)
    env.levels.emit('level', 0.7) // throttled
    env.advance(250)
    env.levels.emit('level', 0.123)
    expect(env.sent.filter((s) => s.m.t === 'level').map((s) => s.m)).toEqual([
      { t: 'level', level: 0.5 },
      { t: 'level', level: 0.12 }
    ])

    env.host.onEvent({ linkId: 'link-1', type: 'message', data: '{"t":"stop"}' })
    expect(env.dictation.toggles).toBe(2)
    env.dictation.emit('entry', { finalText: 'Hello from the garden.', mode: 'hands-free' })
    expect(env.sent.at(-1)?.m).toEqual({ t: 'result', text: 'Hello from the garden.', words: 4 })

    env.host.onEvent({ linkId: 'link-1', type: 'message', data: '{"t":"start"}' })
    env.host.onEvent({ linkId: 'link-1', type: 'message', data: '{"t":"cancel"}' })
    expect(env.dictation.cancels).toBe(1)
    env.host.onEvent({ linkId: 'link-1', type: 'message', data: '{"t":"ping"}' })
    expect(env.sent.at(-1)?.m).toEqual({ t: 'pong' })
    // Garbage and messages for another link are ignored.
    env.host.onEvent({ linkId: 'link-1', type: 'message', data: '{"t":"format c:"}' })
    env.host.onEvent({ linkId: 'other', type: 'message', data: '{"t":"start"}' })
    expect(env.dictation.isListening).toBe(false)
    // Every message sent is one the phone can read.
    for (const s of env.sent) expect(parseDesktopMessage(JSON.stringify(s.m))).not.toBeNull()
  })

  it('keeps the dictation through a short drop and ends it, transcribed, after the grace', async () => {
    const env = setup()
    await linked(env)
    env.host.onEvent({ linkId: 'link-1', type: 'message', data: '{"t":"start"}' })
    env.host.onEvent({ linkId: 'link-1', type: 'state', state: 'interrupted' })
    expect(env.host.getStatus().state).toBe('interrupted')
    expect(env.dictation.isListening).toBe(true)
    expect(env.timers.at(-1)?.ms).toBe(MIC_DROP_GRACE_MS)
    // It came back.
    env.host.onEvent({ linkId: 'link-1', type: 'state', state: 'connected' })
    expect(env.timers.at(-1)?.cleared).toBe(true)
    expect(env.dictation.isListening).toBe(true)
    // Dropped again and stays down.
    env.host.onEvent({ linkId: 'link-1', type: 'state', state: 'interrupted' })
    env.timers.at(-1)!.fn()
    expect(env.dictation.toggles).toBe(2) // stopped: what was said is transcribed
    expect(env.dictation.isListening).toBe(false)
    expect(env.closed).toEqual(['link-1'])
    expect(env.host.getStatus().state).toBe('waiting')
  })

  it('stops a running dictation at once when the link fails', async () => {
    const env = setup()
    await linked(env)
    env.host.onEvent({ linkId: 'link-1', type: 'message', data: '{"t":"start"}' })
    env.host.onEvent({ linkId: 'link-1', type: 'state', state: 'closed' })
    expect(env.dictation.isListening).toBe(false)
    expect(env.dictation.toggles).toBe(2)
    expect(env.closed).toEqual(['link-1'])
  })

  it('replaces the link when a newer offer arrives, and closes it when switched off', async () => {
    const env = setup()
    await linked(env)
    env.cloud.client!.inboxCb!([offer('o2', 'link-2', 1_000_000)])
    expect(env.closed).toEqual(['link-1'])
    expect(env.offers.at(-1)?.linkId).toBe('link-2')
    // Events from the old link are ignored now.
    env.host.onEvent({ linkId: 'link-1', type: 'state', state: 'closed' })
    expect(env.host.getStatus().state).toBe('connecting')
    env.setEnabled(false)
    expect(env.closed).toEqual(['link-1', 'link-2'])
  })

  it('ends up listening when switched off and on again while registering', async () => {
    const env = setup()
    let finish!: (v: { iceServers: unknown[] }) => void
    env.cloud.client!.registerResult = new Promise((r) => (finish = r))
    env.host.start()
    env.setEnabled(false)
    env.setEnabled(true)
    env.cloud.client!.registerResult = Promise.resolve({ iceServers: [] })
    finish({ iceServers: [] })
    await flush()
    await flush()
    expect(env.cloud.client!.subscriptions).toBe(1)
    expect(env.host.getStatus().state).toBe('waiting')
  })

  it('retries a failed registration with backoff', async () => {
    const env = setup()
    env.cloud.client!.registerResult = Promise.reject(new Error('offline'))
    env.host.start()
    await flush()
    expect(env.host.getStatus()).toMatchObject({ state: 'offline', error: 'offline' })
    const retry = env.timers.at(-1)!
    expect(retry.ms).toBe(5_000)
    env.cloud.client!.registerResult = Promise.resolve({ iceServers: [] })
    retry.fn()
    await flush()
    expect(env.cloud.client!.names()).toEqual(['micLink:register', 'micLink:register'])
    expect(env.host.getStatus().state).toBe('waiting')
  })

  it('leaves a dictation on the desktop microphone alone when a phone link fails', async () => {
    const env = setup()
    env.host.start()
    await flush()
    env.dictation.toggle() // hotkey dictation on the desktop's own microphone
    env.cloud.client!.inboxCb!([offer('o1', 'link-1', 1_000_000)])
    env.host.onAnswer({ offerId: 'o1', linkId: 'link-1', error: 'no audio' })
    env.cloud.client!.inboxCb!([offer('o2', 'link-2', 1_000_000)])
    env.cloud.client!.inboxCb!([offer('o3', 'link-3', 1_000_000)]) // replaces link-2
    env.host.onEvent({ linkId: 'link-3', type: 'state', state: 'closed' })
    expect(env.dictation.isListening).toBe(true)
    expect(env.dictation.toggles).toBe(1)
  })

  it('gives up on a link that never connects', async () => {
    const env = setup()
    env.host.start()
    await flush()
    env.cloud.client!.inboxCb!([offer('o1', 'link-1', 1_000_000)])
    const timeout = env.timers.at(-1)!
    expect(timeout.ms).toBe(35_000)
    timeout.fn()
    expect(env.closed).toEqual(['link-1'])
    expect(env.host.getStatus().state).toBe('waiting')
  })

  it('stops being listed when the app quits', async () => {
    const env = setup()
    env.host.start()
    await flush()
    env.host.dispose()
    expect(env.cloud.client!.names()).toEqual(['micLink:register', 'micLink:unregister'])
    expect(env.cloud.client!.unsubscribed).toBe(1)
  })
})
