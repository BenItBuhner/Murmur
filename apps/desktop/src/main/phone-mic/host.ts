import { EventEmitter } from 'node:events'
import type { FunctionReturnType } from 'convex/server'
import type { api as BackendApi } from '@backend/_generated/api'
import {
  MIC_ANSWER_TIMEOUT_MS,
  MIC_DROP_GRACE_MS,
  MIC_LEVEL_INTERVAL_MS,
  MIC_PROTOCOL_VERSION,
  MIC_SIGNAL_TTL_MS,
  parsePhoneMessage,
  resultMessage,
  type DesktopToPhone,
  type MicDictationState,
  type MicIceServer
} from '@backend/lib/micProtocol'
import type {
  PhoneMicAnswerMessage,
  PhoneMicEventMessage,
  PhoneMicOfferMessage,
  PhoneMicStatus
} from '@shared/ipc'
import { createLogger } from '../logger'
import { api } from '../cloud/api'

const log = createLogger('phone-mic')

type Api = typeof BackendApi
export type InboxSignal = FunctionReturnType<Api['micLink']['inbox']>[number]

/** The slice of ConvexClient this host uses (a fake in tests). */
export interface SignalingClient {
  onUpdate(
    query: Api['micLink']['inbox'],
    args: { deviceId: string },
    callback: (signals: InboxSignal[]) => void,
    onError?: (err: Error) => void
  ): () => void
  mutation(
    ref: Api['micLink']['register'],
    args: RegisterArgs
  ): Promise<{ iceServers: MicIceServer[] }>
  mutation(ref: Api['micLink']['unregister'], args: { deviceId: string }): Promise<boolean>
  mutation(ref: Api['micLink']['answer'], args: AnswerArgs): Promise<boolean>
}

interface RegisterArgs {
  deviceId: string
  name: string
  platform: 'win32' | 'darwin' | 'linux'
}

interface AnswerArgs {
  offerId: InboxSignal['id']
  fromName: string
  sdp?: string
  reason?: string
}

/** What the host needs from the account connection (CloudSync in the app). */
export interface CloudSource {
  readonly authedClient: SignalingClient | null
  readonly deviceIdentity: RegisterArgs
  on(event: 'status', cb: () => void): unknown
  off(event: 'status', cb: () => void): unknown
}

/** What the host needs from the dictation controller. */
export interface DictationSource {
  readonly enabled: boolean
  readonly isListening: boolean
  readonly isBusy: boolean
  toggle(): void
  handle(action: { type: 'cancel' }): void
  on(event: 'state', cb: (state: MicDictationState) => void): unknown
  on(
    event: 'entry',
    cb: (entry: { finalText: string; error?: string; mode: string }) => void
  ): unknown
  off(event: string, cb: (...args: never[]) => void): unknown
}

export interface LevelSource {
  on(event: 'level', cb: (level: number) => void): unknown
  off(event: 'level', cb: (level: number) => void): unknown
}

export interface PhoneMicHostDeps {
  /** `audio.phoneMic` now, and a way to hear when settings change. */
  enabled: () => boolean
  onSettingsChange: (cb: () => void) => () => void
  cloud: CloudSource
  dictation: DictationSource
  levels: LevelSource
  /** Sends to the overlay renderer, where the peer connection lives. */
  overlay: {
    offer(m: PhoneMicOfferMessage): void
    send(linkId: string, m: DesktopToPhone): void
    close(linkId: string): void
  }
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

interface Link {
  linkId: string
  phoneName: string
  state: 'connecting' | 'connected' | 'interrupted'
  route?: PhoneMicStatus['route']
  /** The data channel is open. */
  open: boolean
  /** The dictation now running captures this link's audio (so the link ending stops it). */
  carriesDictation: boolean
  /** Ends a link that stays connecting, or one interrupted for longer than the grace. */
  dropTimer: unknown
}

/** A first failed registration retries after this long, doubling up to the cap. */
const REGISTER_RETRY_MS = 5_000
const REGISTER_RETRY_MAX_MS = 5 * 60_000
/** A link still connecting this long after its offer gave up (the phone waits 20 s for the answer). */
const CONNECT_TIMEOUT_MS = MIC_ANSWER_TIMEOUT_MS + MIC_DROP_GRACE_MS

/**
 * Main-process side of "Phone as microphone" (docs/phone-microphone.md).
 *
 * With the switch on and the account connected, the desktop registers as a receiver and holds one
 * idle subscription to its signaling inbox. An offer from a phone goes to the overlay renderer,
 * which answers it with WebRTC; the answer goes back through `micLink.answer`. From then on
 * nothing passes through the backend: audio and control messages run peer to peer. The phone's
 * start / stop drive the dictation like the tray's toggle, and the dictation's state and result go
 * back to the phone.
 */
export class PhoneMicHost extends EventEmitter {
  private client: SignalingClient | null = null
  private unsubscribe: (() => void) | null = null
  private registeredAs: string | null = null
  private registeredName: string | null = null
  private registering: Promise<void> | null = null
  private retryTimer: unknown = null
  private retryDelay = REGISTER_RETRY_MS
  private iceServers: MicIceServer[] = []
  private handled = new Set<string>()
  /** Offers handed to the overlay and not yet answered, by link id. */
  private pendingOffers = new Map<string, InboxSignal['id']>()
  private link: Link | null = null
  private error: string | undefined
  private lastLevelAt = 0
  private disposers: Array<() => void> = []
  private disposed = false
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (t: unknown) => void

  constructor(private readonly deps: PhoneMicHostDeps) {
    super()
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout))
  }

  start(): void {
    const reconcile = (): void => this.reconcile()
    this.disposers.push(this.deps.onSettingsChange(reconcile))
    this.deps.cloud.on('status', reconcile)
    this.disposers.push(() => this.deps.cloud.off('status', reconcile))

    const onState = (state: MicDictationState): void => {
      if (this.link) {
        if (state === 'idle') this.link.carriesDictation = false
        // A dictation that starts while a phone is linked records the phone (capture.ts).
        else if (state === 'listening' && this.link.state !== 'connecting')
          this.link.carriesDictation = true
      }
      this.sendToPhone({ t: 'state', state })
    }
    const onEntry = (entry: { finalText: string; error?: string }): void => {
      if (entry.error && !entry.finalText) this.sendToPhone({ t: 'error', message: entry.error })
      else if (entry.finalText) this.sendToPhone(resultMessage(entry.finalText))
    }
    const onLevel = (level: number): void => {
      if (!this.link?.open || !this.deps.dictation.isListening) return
      const t = this.now()
      if (t - this.lastLevelAt < MIC_LEVEL_INTERVAL_MS) return
      this.lastLevelAt = t
      this.sendToPhone({ t: 'level', level: Math.round(level * 100) / 100 })
    }
    this.deps.dictation.on('state', onState)
    this.deps.dictation.on('entry', onEntry)
    this.deps.levels.on('level', onLevel)
    this.disposers.push(() => {
      this.deps.dictation.off('state', onState as never)
      this.deps.dictation.off('entry', onEntry as never)
      this.deps.levels.off('level', onLevel)
    })
    this.reconcile()
  }

  getStatus(): PhoneMicStatus {
    const enabled = this.deps.enabled()
    if (!enabled) return { enabled, state: 'off' }
    const link = this.link
    if (link)
      return {
        enabled,
        state: link.state,
        phoneName: link.phoneName,
        ...(link.route ? { route: link.route } : {})
      }
    if (!this.deps.cloud.authedClient) return { enabled, state: 'offline' }
    if (this.registeredAs) return { enabled, state: 'waiting' }
    return { enabled, state: 'offline', ...(this.error ? { error: this.error } : {}) }
  }

  // ---- signaling ---------------------------------------------------------------------------

  /** Subscribe and register when the switch is on and the account connected; undo it otherwise. */
  private reconcile(): void {
    if (this.disposed) return
    const client = this.deps.cloud.authedClient
    const want = this.deps.enabled() && client !== null
    if (client !== this.client) this.stopListening(false)
    if (!want) {
      if (!this.deps.enabled()) {
        // Switched off: stop being listed (best effort; a stale row only costs a refused offer).
        if (this.registeredAs && client) {
          const deviceId = this.registeredAs
          void client
            .mutation(api.micLink.unregister, { deviceId })
            .catch((err) => log.debug(`unregister failed: ${String(err)}`))
        }
        this.stopListening(true)
      }
      this.emitStatus()
      return
    }
    const identity = this.deps.cloud.deviceIdentity
    if (
      this.client &&
      this.registeredAs === identity.deviceId &&
      this.registeredName === identity.name
    )
      return
    if (this.registering) return
    this.cancelRetry()
    this.client = client
    this.registering = client
      .mutation(api.micLink.register, identity)
      .then(({ iceServers }) => {
        if (this.disposed) return
        if (!this.deps.enabled()) {
          // Switched off while registering.
          if (this.client === client) this.client = null
          void client
            .mutation(api.micLink.unregister, { deviceId: identity.deviceId })
            .catch(() => undefined)
          return
        }
        if (this.client !== client) return
        this.iceServers = iceServers
        this.registeredAs = identity.deviceId
        this.registeredName = identity.name
        this.error = undefined
        this.retryDelay = REGISTER_RETRY_MS
        this.unsubscribe?.()
        this.unsubscribe = client.onUpdate(
          api.micLink.inbox,
          { deviceId: identity.deviceId },
          (signals) => this.onInbox(signals),
          (err) => {
            this.error = err.message
            log.warn(`inbox subscription error: ${err.message}`)
            this.emitStatus()
          }
        )
        log.info('listening for a phone microphone')
      })
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err)
        log.warn(`could not register for phone microphone: ${this.error}`)
        if (this.client === client) {
          this.client = null
          this.scheduleRetry()
        }
      })
      .finally(() => {
        this.registering = null
        // The switch, the account or the name may have changed while this was in flight.
        if (!this.disposed && !this.retryTimer) this.reconcile()
        else this.emitStatus()
      })
    this.emitStatus()
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return
    const delay = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, REGISTER_RETRY_MAX_MS)
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null
      this.reconcile()
    }, delay)
  }

  private cancelRetry(): void {
    if (this.retryTimer) this.clearTimer(this.retryTimer)
    this.retryTimer = null
  }

  private stopListening(closeLink: boolean): void {
    this.cancelRetry()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.client = null
    this.registeredAs = null
    if (closeLink && this.link) this.closeLink('Phone microphone is turned off on the desktop')
  }

  private onInbox(signals: InboxSignal[]): void {
    const client = this.client
    if (!client) return
    // Forget handled ids that have left the inbox, so the set stays as small as the inbox.
    const present = new Set(signals.map((s) => s.id as string))
    for (const id of this.handled) if (!present.has(id)) this.handled.delete(id)
    for (const signal of signals) {
      if (signal.kind !== 'offer' || this.handled.has(signal.id)) continue
      this.handled.add(signal.id)
      // The server hides expired rows; a far-off clock here must not throw away a fresh offer.
      if (this.now() - signal.createdAt > MIC_SIGNAL_TTL_MS * 5) continue
      this.onOffer(client, signal)
    }
  }

  private onOffer(client: SignalingClient, signal: InboxSignal): void {
    const name = this.deps.cloud.deviceIdentity.name
    if (!this.deps.dictation.enabled) {
      void client
        .mutation(api.micLink.answer, {
          offerId: signal.id,
          fromName: name,
          reason: 'Murmur is paused on this computer'
        })
        .catch(() => undefined)
      return
    }
    // The newest link wins: a phone reconnecting replaces its old link.
    if (this.link) this.closeLink('Another phone linked to this computer', false)
    this.link = {
      linkId: signal.linkId,
      phoneName: signal.fromName,
      state: 'connecting',
      open: false,
      carriesDictation: false,
      dropTimer: null
    }
    const link = this.link
    link.dropTimer = this.setTimer(() => {
      link.dropTimer = null
      if (this.link === link && link.state !== 'connected') {
        log.info('phone link never connected; giving up on it')
        this.closeLink(undefined, false)
      }
    }, CONNECT_TIMEOUT_MS)
    log.info(`phone "${signal.fromName}" is linking (link ${signal.linkId.slice(0, 8)})`)
    this.pendingOffers.set(signal.linkId, signal.id)
    this.deps.overlay.offer({
      offerId: signal.id,
      linkId: signal.linkId,
      phoneName: signal.fromName,
      sdp: signal.sdp,
      iceServers: this.iceServers
    })
    this.emitStatus()
  }

  /** The overlay answered an offer (or failed to). */
  onAnswer(msg: PhoneMicAnswerMessage): void {
    const offerId = this.pendingOffers.get(msg.linkId)
    this.pendingOffers.delete(msg.linkId)
    const client = this.client
    if (!client || !offerId) return
    const name = this.deps.cloud.deviceIdentity.name
    if ('error' in msg) {
      log.warn(`could not answer the phone: ${msg.error}`)
      if (this.link?.linkId === msg.linkId) this.link = null
      void client
        .mutation(api.micLink.answer, { offerId, fromName: name, reason: msg.error })
        .catch(() => undefined)
      this.emitStatus()
      return
    }
    client
      .mutation(api.micLink.answer, { offerId, fromName: name, sdp: msg.sdp })
      .then((sent) => {
        if (!sent && this.link?.linkId === msg.linkId) {
          log.info('the offer expired before it was answered')
          this.closeLink(undefined, false)
        }
      })
      .catch((err: unknown) => {
        log.warn(`answer failed: ${String(err)}`)
        if (this.link?.linkId === msg.linkId) this.closeLink(undefined, false)
      })
  }

  // ---- the link ----------------------------------------------------------------------------

  onEvent(msg: PhoneMicEventMessage): void {
    const link = this.link
    if (!link || link.linkId !== msg.linkId) return
    switch (msg.type) {
      case 'open':
        link.open = true
        this.sendToPhone({
          t: 'welcome',
          v: MIC_PROTOCOL_VERSION,
          name: this.deps.cloud.deviceIdentity.name,
          state: this.deps.dictation.isListening
            ? 'listening'
            : this.deps.dictation.isBusy
              ? 'processing'
              : 'idle'
        })
        break
      case 'message':
        this.onPhoneMessage(link, msg.data)
        break
      case 'state':
        this.onLinkState(link, msg.state, msg.route)
        break
    }
    this.emitStatus()
  }

  private onLinkState(
    link: Link,
    state: 'connecting' | 'connected' | 'interrupted' | 'closed',
    route?: PhoneMicStatus['route']
  ): void {
    if (route) link.route = route
    if (state === 'connected') {
      if (link.dropTimer) this.clearTimer(link.dropTimer)
      link.dropTimer = null
      if (link.state !== 'connected')
        log.info(`phone "${link.phoneName}" linked${link.route ? ` (${link.route})` : ''}`)
      link.state = 'connected'
      return
    }
    if (state === 'interrupted') {
      link.state = 'interrupted'
      if (!link.dropTimer) {
        // Often a Wi-Fi blip that recovers by itself; the dictation keeps running meanwhile.
        link.dropTimer = this.setTimer(() => {
          link.dropTimer = null
          if (this.link === link && link.state === 'interrupted') {
            log.info('phone link did not come back; ending it')
            this.closeLink(undefined, false)
          }
        }, MIC_DROP_GRACE_MS)
      }
      return
    }
    if (state === 'closed') {
      log.info(`phone "${link.phoneName}" link closed`)
      this.closeLink(undefined, false)
    }
  }

  private onPhoneMessage(link: Link, data: string): void {
    const msg = parsePhoneMessage(data)
    if (!msg) return
    const d = this.deps.dictation
    switch (msg.t) {
      case 'hello':
        if (msg.name) link.phoneName = msg.name
        if (msg.v > MIC_PROTOCOL_VERSION)
          this.sendToPhone({
            t: 'error',
            message: 'Update Murmur on this computer to use this phone'
          })
        break
      case 'start':
        if (!d.enabled)
          this.sendToPhone({ t: 'error', message: 'Murmur is paused on this computer' })
        else if (!d.isListening) d.toggle()
        break
      case 'stop':
        if (d.isListening) d.toggle()
        break
      case 'cancel':
        if (d.isListening) d.handle({ type: 'cancel' })
        break
      case 'ping':
        this.sendToPhone({ t: 'pong' })
        break
    }
  }

  /**
   * Ends the link. A dictation running on the phone's audio is stopped first (and transcribed:
   * nothing said before the drop is lost), then the overlay closes the connection and goes back to
   * the desktop's own microphone.
   */
  private closeLink(reason?: string, notify = true): void {
    const link = this.link
    if (!link) return
    this.link = null
    if (link.dropTimer) this.clearTimer(link.dropTimer)
    this.pendingOffers.delete(link.linkId)
    if (notify && reason && link.open)
      this.deps.overlay.send(link.linkId, { t: 'error', message: reason })
    if (link.carriesDictation && this.deps.dictation.isListening) {
      log.info('phone link ended during a dictation; transcribing what was said')
      this.deps.dictation.toggle()
    }
    this.deps.overlay.close(link.linkId)
    this.emitStatus()
  }

  private sendToPhone(m: DesktopToPhone): void {
    const link = this.link
    if (!link?.open) return
    this.deps.overlay.send(link.linkId, m)
  }

  private emitStatus(): void {
    if (!this.disposed) this.emit('status', this.getStatus())
  }

  dispose(): void {
    if (this.link) this.closeLink(undefined, false)
    // Quitting: stop being listed right away (best effort; the heartbeat going quiet covers it).
    const client = this.client
    if (client && this.registeredAs)
      void client
        .mutation(api.micLink.unregister, { deviceId: this.registeredAs })
        .catch(() => undefined)
    this.stopListening(false)
    for (const d of this.disposers.splice(0)) d()
    this.disposed = true
  }
}
