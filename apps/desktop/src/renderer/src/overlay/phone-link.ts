import {
  MIC_CONTROL_LABEL,
  MIC_ICE_GATHER_MS,
  routeOf,
  tuneOpusSdp,
  type DesktopToPhone
} from '@backend/lib/micProtocol'
import type {
  PhoneMicAnswerMessage,
  PhoneMicEventMessage,
  PhoneMicLinkState,
  PhoneMicOfferMessage
} from '@shared/ipc'

export interface PhoneLinkEvents {
  answer: (m: PhoneMicAnswerMessage) => void
  event: (m: PhoneMicEventMessage) => void
  /** The phone's audio arrived (a stream) or went away (null): the microphone to capture from. */
  stream: (stream: MediaStream | null) => void
}

type StateEvent = Extract<PhoneMicEventMessage, { type: 'state' }>

interface Link {
  linkId: string
  pc: RTCPeerConnection
  channel: RTCDataChannel | null
  stream: MediaStream | null
  sink: HTMLAudioElement | null
  /** The capture records `stream` (only once the link is up, so a link that never connects
   * cannot leave the desktop recording a silent track). */
  handedOver: boolean
  state: PhoneMicLinkState
}

/** Resolves once ICE gathering completes, or after `ms` with what has been gathered by then. */
export function gatherComplete(pc: RTCPeerConnection, ms = MIC_ICE_GATHER_MS): Promise<void> {
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

/** How the selected candidate pair reaches the phone (direct on the LAN, via STUN, relayed). */
export async function selectedRoute(
  pc: RTCPeerConnection
): Promise<'direct' | 'stun' | 'relay' | 'unknown'> {
  try {
    const stats = await pc.getStats()
    let pairId: string | undefined
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId
    })
    let pair: (RTCStats & { localCandidateId?: string; remoteCandidateId?: string }) | undefined
    stats.forEach((s) => {
      if (s.type !== 'candidate-pair') return
      if (pairId ? s.id === pairId : s.nominated && s.state === 'succeeded') pair = s
    })
    if (!pair) return 'unknown'
    const local = pair.localCandidateId ? stats.get(pair.localCandidateId) : undefined
    const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : undefined
    return routeOf(local?.candidateType, remote?.candidateType)
  } catch {
    return 'unknown'
  }
}

/**
 * The desktop end of a phone-microphone link (docs/phone-microphone.md). It answers the phone's
 * WebRTC offer, hands the phone's audio track to the microphone capture, and relays the control
 * channel to main. One link at a time: a new offer replaces the current link.
 *
 * Chromium only pulls a remote track's audio through Web Audio while the stream is also attached
 * to a media element, so the stream plays into a muted <audio> that nobody hears.
 */
export class PhoneLinkHost {
  private link: Link | null = null

  constructor(private readonly events: PhoneLinkEvents) {}

  async accept(offer: PhoneMicOfferMessage): Promise<void> {
    this.close()
    const pc = new RTCPeerConnection({ iceServers: offer.iceServers })
    const link: Link = {
      linkId: offer.linkId,
      pc,
      channel: null,
      stream: null,
      sink: null,
      handedOver: false,
      state: 'connecting'
    }
    this.link = link
    const handOver = (): void => {
      if (this.link !== link || link.handedOver || !link.stream) return
      if (pc.connectionState !== 'connected') return
      link.handedOver = true
      this.events.stream(link.stream)
    }
    const report = (state: PhoneMicLinkState, route?: StateEvent['route']): void => {
      if (this.link !== link && state !== 'closed') return
      if (state === 'connected') handOver()
      link.state = state
      this.events.event({ linkId: link.linkId, type: 'state', state, ...(route ? { route } : {}) })
    }

    pc.ontrack = (e) => {
      if (this.link !== link || e.track.kind !== 'audio') return
      const stream = e.streams[0] ?? new MediaStream([e.track])
      link.stream = stream
      const sink = new Audio()
      sink.muted = true
      sink.srcObject = stream
      void sink.play().catch(() => undefined)
      link.sink = sink
      handOver()
    }
    pc.ondatachannel = (e) => {
      if (this.link !== link || e.channel.label !== MIC_CONTROL_LABEL) return
      const channel = e.channel
      link.channel = channel
      const opened = (): void => this.events.event({ linkId: link.linkId, type: 'open' })
      if (channel.readyState === 'open') opened()
      else channel.onopen = opened
      // The phone hung up (or its page went away): the control channel closes at once, well
      // before ICE would notice.
      channel.onclose = () => {
        if (this.link === link) report('closed')
      }
      channel.onmessage = (m) => {
        if (this.link === link && typeof m.data === 'string')
          this.events.event({ linkId: link.linkId, type: 'message', data: m.data })
      }
    }
    pc.onconnectionstatechange = () => {
      if (this.link !== link) return
      switch (pc.connectionState) {
        case 'connected':
          void selectedRoute(pc).then((route) => report('connected', route))
          break
        case 'disconnected':
          report('interrupted')
          break
        case 'failed':
        case 'closed':
          report('closed')
          break
      }
    }

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription({ type: 'answer', sdp: tuneOpusSdp(answer.sdp ?? '') })
      await gatherComplete(pc)
      if (this.link !== link) return
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('No local description')
      this.events.answer({ offerId: offer.offerId, linkId: offer.linkId, sdp })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.events.answer({ offerId: offer.offerId, linkId: offer.linkId, error: message })
      if (this.link === link) this.close()
    }
  }

  send(linkId: string, message: DesktopToPhone): void {
    const channel = this.link?.linkId === linkId ? this.link.channel : null
    if (channel?.readyState === 'open') channel.send(JSON.stringify(message))
  }

  /** Closes the link (all of them when no id is given) and gives the microphone back. */
  close(linkId?: string): void {
    const link = this.link
    if (!link || (linkId && link.linkId !== linkId)) return
    this.link = null
    try {
      link.channel?.close()
    } catch {
      // already closed
    }
    link.pc.close()
    if (link.sink) {
      link.sink.pause()
      link.sink.srcObject = null
    }
    if (link.handedOver) this.events.stream(null)
    if (link.state !== 'closed')
      this.events.event({ linkId: link.linkId, type: 'state', state: 'closed' })
  }
}
