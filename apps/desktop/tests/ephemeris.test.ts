import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EPHEMERIS_TIMEOUT_MS,
  ephemerisEndpoint,
  sendToEphemeris,
  type FetchLike
} from '@core/ephemeris'
import { defaultSettings, parseSettings, type Settings } from '@shared/settings'

const quiet = { warn: vi.fn() }

function withEphemeris(e: Partial<Settings['ephemeris']>): Pick<Settings, 'ephemeris'> {
  return { ephemeris: { ...defaultSettings().ephemeris, ...e } }
}

const payload = {
  text: 'Call the dentist on Friday',
  kind: 'note' as const,
  app: 'Slack',
  startedAt: '2026-11-02T10:00:00.000Z',
  endedAt: '2026-11-02T10:00:04.000Z'
}

afterEach(() => {
  vi.useRealTimers()
  quiet.warn.mockReset()
})

describe('ephemeris settings', () => {
  it('is off by default and pointed at the local server', () => {
    const e = parseSettings({}).ephemeris
    expect(e).toEqual({
      enabled: false,
      url: 'http://127.0.0.1:4317',
      token: '',
      mode: 'all',
      noteHotkey: []
    })
  })

  it('keeps the rest of the file when the ephemeris section is invalid', () => {
    const s = parseSettings({ ephemeris: { mode: 'sometimes' }, general: { theme: 'dark' } })
    expect(s.ephemeris.mode).toBe('all')
    expect(s.general.theme).toBe('dark')
  })
})

describe('sendToEphemeris', () => {
  it('sends nothing while the integration is off', async () => {
    const fetchImpl = vi.fn<FetchLike>()
    expect(await sendToEphemeris(withEphemeris({}), payload, fetchImpl, quiet)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends nothing for empty text', async () => {
    const fetchImpl = vi.fn<FetchLike>()
    const s = withEphemeris({ enabled: true })
    expect(await sendToEphemeris(s, { ...payload, text: '  ' }, fetchImpl, quiet)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('posts the transcript to the transcript endpoint with the bearer token', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({ ok: true, status: 201 })
    const s = withEphemeris({ enabled: true, url: 'http://127.0.0.1:9999/', token: ' secret ' })
    expect(await sendToEphemeris(s, payload, fetchImpl, quiet)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:9999/api/signals/transcript')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret'
    })
    expect(JSON.parse(init.body as string)).toEqual({ ...payload, source: 'murmur' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('leaves out the Authorization header without a token', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({ ok: true, status: 201 })
    await sendToEphemeris(withEphemeris({ enabled: true }), payload, fetchImpl, quiet)
    expect(fetchImpl.mock.calls[0][0]).toBe(ephemerisEndpoint('http://127.0.0.1:4317'))
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('swallows a network error and logs it', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new TypeError('fetch failed'))
    const s = withEphemeris({ enabled: true })
    await expect(sendToEphemeris(s, payload, fetchImpl, quiet)).resolves.toBe(false)
    expect(quiet.warn).toHaveBeenCalledTimes(1)
  })

  it('reports a non-2xx answer as not delivered', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({ ok: false, status: 401 })
    const s = withEphemeris({ enabled: true })
    expect(await sendToEphemeris(s, payload, fetchImpl, quiet)).toBe(false)
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining('401'))
  })

  it('gives up after the timeout, even on a fetch that ignores the abort signal', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn<FetchLike>((_url, init) => {
      signal = init.signal ?? undefined
      return new Promise(() => undefined)
    })
    const s = withEphemeris({ enabled: true })
    const sent = sendToEphemeris(s, payload, fetchImpl, quiet)
    await vi.advanceTimersByTimeAsync(EPHEMERIS_TIMEOUT_MS - 1)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(sent).resolves.toBe(false)
    expect(signal?.aborted).toBe(true)
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining('3000 ms'), expect.anything())
  })
})
