import { afterEach, describe, expect, it, vi } from 'vitest'
import { dropSilentSegments, isSilenceHallucination } from '../../text-engine/src/hallucination'
import { STT_ENV, ada, jsonResponse, makeWav, setup, sttRequest, stubEnv, stubFetch } from './helpers'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('stock phrases said to silence', () => {
  it('knows the phrases, repeated or not, and nothing longer', () => {
    expect(isSilenceHallucination(' Thank you.')).toBe(true)
    expect(isSilenceHallucination('Thank you. Thank you.')).toBe(true)
    expect(isSilenceHallucination('Thanks for watching!')).toBe(true)
    expect(isSilenceHallucination('Thank you for the report.')).toBe(false)
  })

  it('drops a stock-phrase segment the model calls silence, and keeps one it heard', () => {
    expect(
      dropSilentSegments(
        { text: ' Send it. Thank you.', segments: [{ text: ' Send it.', no_speech_prob: 0.01 }, { text: ' Thank you.', no_speech_prob: 0.93 }] },
        6
      )
    ).toEqual({ text: 'Send it.', segments: [{ text: ' Send it.', no_speech_prob: 0.01 }] })
    expect(
      dropSilentSegments({ text: ' Thank you.', segments: [{ text: ' Thank you.', no_speech_prob: 0.02 }] }, 1.4)
    ).toBeNull()
  })

  it('drops the phrase from a clip too short to hold it, even without segments', () => {
    expect(dropSilentSegments({ text: ' Thank you.' }, 0.36)).toEqual({ text: '', segments: undefined })
    expect(dropSilentSegments({ text: ' Thank you.' }, 1.2)).toBeNull()
  })
})

describe('/v1/audio/transcriptions and silence', () => {
  const formats = (calls: Array<{ init: RequestInit }>): Array<string | null> =>
    calls.map((c) => (c.init.body as FormData).get('response_format') as string | null)

  it('asks for the verbose answer, drops the silent phrase, and answers in the plain shape', async () => {
    stubEnv(STT_ENV)
    const calls = stubFetch(() =>
      jsonResponse({
        text: ' Thank you.',
        duration: 2,
        segments: [{ id: 0, text: ' Thank you.', no_speech_prob: 0.93 }]
      })
    )
    const t = setup()
    const res = await t.withIdentity(ada).fetch('/v1/audio/transcriptions', await sttRequest(makeWav(2)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: '', duration: 2 })
    expect(formats(calls)).toEqual(['verbose_json'])
  })

  it('keeps words the model heard', async () => {
    stubEnv(STT_ENV)
    stubFetch(() =>
      jsonResponse({ text: ' Thank you.', duration: 2, segments: [{ text: ' Thank you.', no_speech_prob: 0.01 }] })
    )
    const t = setup()
    const res = await t.withIdentity(ada).fetch('/v1/audio/transcriptions', await sttRequest(makeWav(2)))
    expect(await res.json()).toEqual({ text: ' Thank you.', duration: 2 })
  })

  it('asks again in plain JSON when the provider has no verbose answers', async () => {
    stubEnv(STT_ENV)
    let n = 0
    const calls = stubFetch(() =>
      n++ === 0
        ? jsonResponse({ error: { message: 'response_format verbose_json is not supported', code: 'invalid' } }, 400)
        : jsonResponse({ text: 'hello there' })
    )
    const t = setup()
    const res = await t.withIdentity(ada).fetch('/v1/audio/transcriptions', await sttRequest(makeWav(2)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'hello there' })
    expect(formats(calls)).toEqual(['verbose_json', 'json'])
  })
})
