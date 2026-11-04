import {
  MIC_ANSWER_TIMEOUT_MS,
  MIC_CONTROL_LABEL,
  MIC_ICE_GATHER_MS,
  MIC_PROTOCOL_VERSION,
  parseDesktopMessage,
  tuneOpusSdp,
  type DesktopToPhone,
  type MicIceServer,
  type PhoneToDesktop
} from '@/lib/mic-protocol'

/*
 * The phone end of "Phone as microphone" (docs/phone-microphone.md), for any phone browser. It
 * sends the phone's microphone to a desktop of the same account over WebRTC, peer to peer. Convex
 * carries one offer and one answer, through the `Signaling` interface (the page implements it with
 * the signed-in Convex client); nothing of the audio goes anywhere but the desktop.
 */

export interface Receiver {
  deviceId: string
  name: string
  platform: string
  registeredAt: number
}

export interface AnswerSignal {
  id: string
  kind: 'offer' | 'answer' | 'decline'
  linkId: string
  fromName: string
  sdp: string
  reason?: string
}

export interface Signaling {
  receivers(): Promise<{ receivers: Receiver[]; iceServers: MicIceServer[] }>
  offer(args: {
    to: string
    from: string
    fromName: string
    linkId: string
    sdp: string
  }): Promise<void>
  /** Resolves with the first signal for `linkId` addressed to `deviceId`; the watch ends with it. */
  waitForAnswer(deviceId: string, linkId: string, timeoutMs: number): Promise<AnswerSignal>
  take(id: string): Promise<void>
}

export type LinkPhase = 'idle' | 'connecting' | 'linked' | 'interrupted' | 'closed'

export interface PhoneMicEvents {
  phase?: (phase: LinkPhase, detail?: string) => void
  message?: (m: DesktopToPhone) => void
}

export class SignalingError extends Error {}

const STORAGE_KEY = 'murmur.phoneMic.deviceId'

/** A stable id for this browser, so the desktop sees the same phone across links. */
export function phoneDeviceId(storage: Pick<Storage, 'getItem' | 'setItem'> | null): string {
  try {
    const existing = storage?.getItem(STORAGE_KEY)
    if (existing && /^[\w-]{8,64}$/.test(existing)) return existing
  } catch {
    // private mode: a fresh id per visit is fine
  }
  const id = `web-${randomId()}`
  try {
    storage?.setItem(STORAGE_KEY, id)
  } catch {
    // ignore
  }
  return id
}

export function randomId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A readable name for this phone from its user agent. */
export function phoneName(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone'
  if (/iPad/.test(userAgent)) return 'iPad'
  if (/Android/.test(userAgent)) {
    const model = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(userAgent)?.[1]?.trim()
    return model && model !== 'K' && model.length <= 40 ? model : 'Android phone'
  }
  return 'Phone browser'
}

/** Resolves once ICE gathering completes, or after `ms` with what has been gathered by then. */
function gatherComplete(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') done()
    }
    const timer = setTimeout(done, ms)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

/** Turns the reasons links fail into one sentence for the person holding the phone. */
export function friendlyLinkError(err: unknown, desktopName: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/not_listening/.test(message))
    return `${desktopName} is not listening for a phone any more. Turn on Phone as microphone in Murmur's Microphone settings there.`
  if (/NotAllowedError|Permission/i.test(message))
    return 'Murmur needs permission to use this phone’s microphone. Allow it in the browser and try again.'
  if (/NotFoundError/.test(message)) return 'This phone has no microphone Murmur can use.'
  if (err instanceof SignalingError) return message
  return `Could not link to ${desktopName}: ${message}`
}

/**
 * One link from this phone to one desktop. `connect` resolves once the desktop answered; the
 * `phase` event follows the connection after that.
 */
export class PhoneMicLink {
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private stream: MediaStream | null = null
  private ownsStream = false
  private phase: LinkPhase = 'idle'
  readonly linkId = randomId()

  constructor(
    private readonly signaling: Signaling,
    private readonly opts: {
      deviceId: string
      name: string
      events: PhoneMicEvents
      /** For tests: a stream to send instead of asking for the microphone. */
      stream?: MediaStream
    }
  ) {}

  get currentPhase(): LinkPhase {
    return this.phase
  }

  /** A getter, so a check after an await sees a close() that ran meanwhile. */
  private get closed(): boolean {
    return this.phase === 'closed'
  }

  private setPhase(phase: LinkPhase, detail?: string): void {
    if (this.phase === 'closed') return
    this.phase = phase
    this.opts.events.phase?.(phase, detail)
  }

  async connect(receiver: Receiver, iceServers: MicIceServer[]): Promise<void> {
    this.setPhase('connecting')
    try {
      this.stream =
        this.opts.stream ??
        (await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            // Nothing plays on the phone, so there is no echo to cancel; the desktop's own
            // noise suppression and gain settings apply to its microphone, these to this one.
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: true
          }
        }))
      this.ownsStream = !this.opts.stream
      // Disconnected while the browser asked for the microphone: let it go again.
      if (this.closed) {
        this.releaseStream()
        return
      }
      const pc = new RTCPeerConnection({ iceServers })
      this.pc = pc
      const track = this.stream.getAudioTracks()[0]
      if (!track) throw new SignalingError('This phone has no microphone Murmur can use.')
      pc.addTransceiver(track, { direction: 'sendonly', streams: [this.stream] })
      const channel = pc.createDataChannel(MIC_CONTROL_LABEL, { ordered: true })
      this.channel = channel
      channel.onopen = () => {
        this.send({ t: 'hello', v: MIC_PROTOCOL_VERSION, name: this.opts.name })
      }
      channel.onmessage = (e) => {
        const msg = typeof e.data === 'string' ? parseDesktopMessage(e.data) : null
        if (msg) this.opts.events.message?.(msg)
      }
      channel.onclose = () => {
        if (this.phase !== 'closed') this.close('The desktop closed the link.')
      }
      pc.onconnectionstatechange = () => {
        switch (pc.connectionState) {
          case 'connected':
            this.setPhase('linked')
            break
          case 'disconnected':
            this.setPhase('interrupted')
            break
          case 'failed':
            this.close('The connection to the desktop was lost.')
            break
        }
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription({ type: 'offer', sdp: tuneOpusSdp(offer.sdp ?? '') })
      await gatherComplete(pc, MIC_ICE_GATHER_MS)
      if (this.closed) return
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new SignalingError('Could not prepare the connection.')
      const answer = this.signaling.waitForAnswer(
        this.opts.deviceId,
        this.linkId,
        MIC_ANSWER_TIMEOUT_MS
      )
      // A watch that is never awaited (the offer failed) must not surface as unhandled.
      answer.catch(() => undefined)
      await this.signaling.offer({
        to: receiver.deviceId,
        from: this.opts.deviceId,
        fromName: this.opts.name,
        linkId: this.linkId,
        sdp
      })
      const reply = await answer
      void this.signaling.take(reply.id).catch(() => undefined)
      if (this.closed) return
      if (reply.kind !== 'answer' || !reply.sdp)
        throw new SignalingError(reply.reason ?? `${receiver.name} declined the link.`)
      await pc.setRemoteDescription({ type: 'answer', sdp: reply.sdp })
    } catch (err) {
      if (this.closed) return
      this.close(friendlyLinkError(err, receiver.name))
      throw err
    }
  }

  send(m: PhoneToDesktop): boolean {
    if (this.channel?.readyState !== 'open') return false
    this.channel.send(JSON.stringify(m))
    return true
  }

  close(detail?: string): void {
    if (this.phase === 'closed') return
    this.setPhase('closed', detail)
    try {
      this.channel?.close()
    } catch {
      // already closed
    }
    this.pc?.close()
    this.releaseStream()
    this.pc = null
    this.channel = null
  }

  private releaseStream(): void {
    if (this.ownsStream) for (const t of this.stream?.getTracks() ?? []) t.stop()
  }
}
