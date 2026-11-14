import { describe, expect, it, vi } from 'vitest'
import { Trigger, type TriggerEvent } from './trigger'
import { dictate, formatContext, GatewayError, sttPrompt, transcribe } from './pipeline'
import { DEFAULT_SETTINGS, settingsFromAccount } from './settings'
import { appendDictation, miniUrl } from './ui'
import { downsample, encodeWav } from './wav'

const SETTINGS = settingsFromAccount(
  [{ word: 'Kubernetes', aliases: ['cooper netties'] }, { word: 'Convex' }],
  [{ trigger: 'my sign off', content: 'Thanks, Bennett' }],
  {
    formatting: { mode: 'smart', tone: 'professional', llmInstructions: 'British spelling' },
    language: 'en'
  }
)
const wav = new Blob([encodeWav(new Float32Array(1600)) as BlobPart], { type: 'audio/wav' })
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('settings from the account', () => {
  it('maps the synced dictionary, snippets and preferences', () => {
    expect(SETTINGS.dictionary.map((d) => d.word)).toEqual(['Kubernetes', 'Convex'])
    expect(SETTINGS.formatting).toMatchObject({
      mode: 'smart',
      tone: 'professional',
      instructions: 'British spelling'
    })
    expect(SETTINGS.language).toBe('en')
  })
  it('falls back to the desktop defaults for anything missing or unknown', () => {
    const s = settingsFromAccount(null, undefined, { formatting: { mode: 'bogus' as never } })
    expect(s.formatting.mode).toBe('smart')
    expect(s.language).toBe('auto')
    expect(s.dictionary).toEqual([])
  })
})

describe('the request the gateway gets', () => {
  it('sends the WAV, the model id, the language and the vocabulary prompt', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData
      expect(form.get('model')).toBe('murmur-transcribe')
      expect(form.get('language')).toBe('en')
      expect(String(form.get('prompt'))).toContain('Kubernetes, Convex, my sign off')
      expect((form.get('file') as File).type).toBe('audio/wav')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t1')
      return json(200, { text: ' hello there ' })
    })
    const text = await transcribe(wav, SETTINGS, {
      gatewayUrl: 'https://gw/v1',
      token: async () => 't1',
      fetch: fetch as never
    })
    expect(text).toBe('hello there')
    expect(fetch.mock.calls[0][0]).toBe('https://gw/v1/audio/transcriptions')
  })
  it('refreshes the token once after a 401', async () => {
    const token = vi.fn(async (force: boolean) => (force ? 'fresh' : 'stale'))
    const fetch = vi.fn(async (_u: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization === 'Bearer fresh'
        ? json(200, { text: 'ok' })
        : json(401, {})
    )
    expect(
      await transcribe(wav, SETTINGS, { gatewayUrl: '/gw/v1', token, fetch: fetch as never })
    ).toBe('ok')
    expect(token.mock.calls.map((c) => c[0])).toEqual([false, true])
  })
  it('surfaces the gateway message on errors', async () => {
    const fetch = async () =>
      json(429, { error: { message: 'Daily limit reached', code: 'limit' } })
    await expect(
      transcribe(wav, SETTINGS, {
        gatewayUrl: '/gw/v1',
        token: async () => 't',
        fetch: fetch as never
      })
    ).rejects.toMatchObject({
      message: 'Daily limit reached',
      code: 'limit'
    })
  })
  it('asks to sign in without a session', async () => {
    await expect(
      transcribe(wav, SETTINGS, { gatewayUrl: '/gw/v1', token: async () => null })
    ).rejects.toBeInstanceOf(GatewayError)
  })
  it('sends formatting context like the desktop app, for the notes category', () => {
    const ctx = formatContext(SETTINGS)
    expect(ctx).toMatchObject({
      category: 'notes',
      tone: 'professional',
      language: 'en',
      instructions: 'British spelling'
    })
    expect(ctx.keepVerbatim).toEqual(['my sign off'])
  })
  it('leaves the prompt out when the vocabulary prompt is off', () => {
    expect(sttPrompt({ ...SETTINGS, useDictionaryPrompt: false })).toBeUndefined()
  })
})

describe('a whole dictation', () => {
  it('formats on the gateway, then applies the dictionary and snippets', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/audio/transcriptions'))
        return json(200, { text: 'the cooper netties notes my sign off' })
      const body = JSON.parse(String(init.body))
      expect(body.context.dictionary).toHaveLength(2)
      return json(200, {
        text: 'The cooper netties notes. My sign off',
        pressEnter: false,
        status: { outcome: 'used', attempts: 1 },
        llmMs: 5,
        stages: []
      })
    })
    const r = await dictate(wav, SETTINGS, {
      gatewayUrl: '/gw/v1',
      token: async () => 't',
      fetch: fetch as never
    })
    expect(r.text).toContain('Kubernetes notes')
    expect(r.text).toContain('Thanks, Bennett')
    expect(r.formatting).toBe('used')
  })
  it('keeps the dictation with rule-based formatting when /format fails', async () => {
    const fetch = async (url: string) =>
      url.endsWith('/format')
        ? json(503, { error: { message: 'busy' } })
        : json(200, { text: 'um hello world' })
    const r = await dictate(wav, SETTINGS, {
      gatewayUrl: '/gw/v1',
      token: async () => 't',
      fetch: fetch as never
    })
    expect(r.text.toLowerCase()).toContain('hello world')
  })
  it('does not call /format for Light formatting', async () => {
    const fetch = vi.fn(async () => json(200, { text: 'hello world' }))
    const s = {
      ...DEFAULT_SETTINGS,
      formatting: { ...DEFAULT_SETTINGS.formatting, mode: 'light' as const }
    }
    const r = await dictate(wav, s, {
      gatewayUrl: '/gw/v1',
      token: async () => 't',
      fetch: fetch as never
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(r.text).toMatch(/^Hello world/)
  })
  it('returns nothing for silence', async () => {
    const fetch = async () => json(200, { text: '' })
    expect(
      (
        await dictate(wav, SETTINGS, {
          gatewayUrl: '/',
          token: async () => 't',
          fetch: fetch as never
        })
      ).text
    ).toBe('')
  })
})

describe('the trigger', () => {
  const key = (k: string, code: string, ctrl = false, meta = false, repeat = false) => ({
    key: k,
    code,
    ctrlKey: ctrl,
    metaKey: meta,
    repeat
  })
  const run = () => {
    const events: TriggerEvent[] = []
    return { t: new Trigger((e) => events.push(e)), events }
  }
  it('Ctrl + Win held is push-to-talk', () => {
    const { t, events } = run()
    t.down(key('Control', 'ControlLeft', true), false)
    t.down(key('Meta', 'MetaLeft', true, true), false)
    t.down(key('Meta', 'MetaLeft', true, true, true), false)
    t.up(key('Meta', 'MetaLeft', true))
    expect(events).toEqual(['hold-start', 'hold-end'])
  })
  it('Ctrl + Win + Space toggles hands-free and does not end on release', () => {
    const { t, events } = run()
    t.down(key('Control', 'ControlLeft', true), false)
    t.down(key('Meta', 'MetaLeft', true, true), false)
    t.down(key(' ', 'Space', true, true), false)
    t.up(key(' ', 'Space', true, true))
    t.up(key('Meta', 'MetaLeft', true))
    expect(events).toEqual(['hold-start', 'toggle'])
  })
  it('Space is push-to-talk only outside text fields', () => {
    const { t, events } = run()
    expect(t.down(key(' ', 'Space'), true)).toBe(false)
    t.down(key(' ', 'Space'), false)
    t.up(key(' ', 'Space'))
    expect(events).toEqual(['hold-start', 'hold-end'])
  })
  it('losing focus ends a held dictation', () => {
    const { t, events } = run()
    t.down(key(' ', 'Space'), false)
    t.blur()
    expect(events).toEqual(['hold-start', 'hold-end'])
  })
})

describe('audio and text helpers', () => {
  it('writes a 16 kHz mono 16-bit WAV', () => {
    const bytes = encodeWav(new Float32Array([0, 1, -1]))
    const v = new DataView(bytes.buffer)
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF')
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getInt16(46, true)).toBe(32767)
    expect(v.getInt16(48, true)).toBe(-32768)
  })
  it('downsamples 48 kHz to 16 kHz', () => {
    expect(downsample(new Float32Array(4800), 48000).length).toBe(1600)
  })
  it('appends dictations as sentences', () => {
    expect(appendDictation('', 'Hello.')).toBe('Hello.')
    expect(appendDictation('Hello.', 'World.')).toBe('Hello. World.')
    expect(appendDictation('Hello.\n', 'World.')).toBe('Hello.\nWorld.')
    expect(appendDictation('A', '- one\n- two')).toBe('A\n\n- one\n- two')
  })
  it('builds the small-window URL', () => {
    expect(miniUrl('https://x.app/?source=pwa#a')).toBe('https://x.app/?mini=1')
  })
})
