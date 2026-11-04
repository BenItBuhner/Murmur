import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  friendlyLinkError,
  phoneDeviceId,
  phoneName,
  PhoneMicLink,
  SignalingError,
  type Signaling
} from './phone-mic'

describe('phone microphone helpers', () => {
  it('names the phone from its user agent', () => {
    expect(
      phoneName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe('iPhone')
    expect(
      phoneName(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro Build/AP4A.250105.002) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'
      )
    ).toBe('Pixel 9 Pro')
    // Chrome's reduced user agent hides the model as "K".
    expect(
      phoneName(
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'
      )
    ).toBe('Android phone')
    expect(phoneName('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Phone browser')
  })

  it('keeps one id per browser, and copes without storage', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v)
    }
    const id = phoneDeviceId(storage)
    expect(id).toMatch(/^web-[0-9a-f]{24}$/)
    expect(phoneDeviceId(storage)).toBe(id)
    store.set('murmur.phoneMic.deviceId', 'bad id!')
    expect(phoneDeviceId(storage)).not.toBe('bad id!')
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    expect(phoneDeviceId(throwing)).toMatch(/^web-/)
    expect(phoneDeviceId(null)).toMatch(/^web-/)
  })

  it('explains failures in one sentence', () => {
    expect(
      friendlyLinkError(new Error('[CONVEX M(micLink:offer)] not_listening'), 'Laptop')
    ).toMatch(/Laptop is not listening/)
    const denied = new Error('Permission denied')
    denied.name = 'NotAllowedError'
    expect(friendlyLinkError(denied, 'Laptop')).toMatch(/permission/)
    expect(friendlyLinkError(new SignalingError('The computer did not answer.'), 'Laptop')).toBe(
      'The computer did not answer.'
    )
    expect(friendlyLinkError(new Error('boom'), 'Laptop')).toBe('Could not link to Laptop: boom')
  })
})

describe('PhoneMicLink', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lets the microphone go and sends nothing when disconnected during the permission prompt', async () => {
    let grant!: (stream: MediaStream) => void
    const stop = vi.fn()
    const stream = {
      getAudioTracks: () => [{}],
      getTracks: () => [{ stop }]
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => new Promise<MediaStream>((r) => (grant = r)) }
    })
    const peerConnection = vi.fn()
    vi.stubGlobal('RTCPeerConnection', peerConnection)
    const signaling: Signaling = {
      receivers: vi.fn(),
      offer: vi.fn(),
      waitForAnswer: vi.fn(),
      take: vi.fn()
    }
    const phases: string[] = []
    const link = new PhoneMicLink(signaling, {
      deviceId: 'web-phone',
      name: 'iPhone',
      events: { phase: (p) => phases.push(p) }
    })
    const connecting = link.connect(
      { deviceId: 'desk', name: 'Desk', platform: 'linux', registeredAt: 0 },
      []
    )
    link.close()
    grant(stream)
    await connecting
    expect(stop).toHaveBeenCalled()
    expect(peerConnection).not.toHaveBeenCalled()
    expect(signaling.offer).not.toHaveBeenCalled()
    expect(phases).toEqual(['connecting', 'closed'])
  })
})
