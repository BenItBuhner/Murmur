import { describe, expect, it } from 'vitest'
import { chooseLlmModel, chooseSttModel, parseTier, type Upstream } from '../convex/lib/inference'
import { hedgeAfterMs, hedged } from '../convex/lib/upstream'

const stt: Upstream = { baseUrl: 'http://p/v1', apiKey: '', model: 'transcribe-1', fastModel: 'transcribe-1-fast', bgModel: 'murmur-bg-transcribe' }
const llm: Upstream = { baseUrl: 'http://p/v1', apiKey: '', model: 'complete', fastModel: 'murmur-fast-format', bgModel: 'murmur-bg-format' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('tiered routing', () => {
  it('reads the tier header, defaulting to release', () => {
    expect(parseTier('background')).toBe('background')
    expect(parseTier(' Background ')).toBe('background')
    expect(parseTier(null)).toBe('release')
    expect(parseTier('whatever')).toBe('release')
  })

  it('sends background speech to the background pool in both speed modes, the release to the fast or normal model', () => {
    expect(chooseSttModel(stt, 'free', 'normal', 'background')).toMatchObject({ model: 'murmur-bg-transcribe', normalModel: 'transcribe-1' })
    expect(chooseSttModel(stt, 'free', 'fast', 'background').model).toBe('murmur-bg-transcribe')
    expect(chooseSttModel(stt, 'free', 'normal', 'release').model).toBe('transcribe-1')
    expect(chooseSttModel(stt, 'free', 'fast', 'release').model).toBe('transcribe-1-fast')
    // Without a background model nothing changes.
    expect(chooseSttModel({ ...stt, bgModel: undefined }, 'free', 'normal', 'background').model).toBe('transcribe-1')
  })

  it('picks formatting models per tier and speed, with the other release model as the hedge', () => {
    expect(chooseLlmModel(llm, 'free', 'background', 'normal')).toEqual({ model: 'murmur-bg-format', alternate: null })
    expect(chooseLlmModel(llm, 'free', 'release', 'normal')).toEqual({ model: 'complete', alternate: 'murmur-fast-format' })
    expect(chooseLlmModel(llm, 'free', 'release', 'fast')).toEqual({ model: 'murmur-fast-format', alternate: 'complete' })
    expect(chooseLlmModel({ ...llm, fastModel: undefined, bgModel: undefined }, 'free', 'background', 'fast')).toEqual({ model: 'complete', alternate: null })
  })
})

describe('hedged requests', () => {
  const ok = (v: string) => v.startsWith('ok')
  it('does not hedge an answer that comes in time', async () => {
    let alt = 0
    const r = await hedged(async () => 'ok-a', async () => (alt++, 'ok-b'), 50, ok)
    expect(r).toEqual({ value: 'ok-a', hedged: false, winner: 'primary' })
    expect(alt).toBe(0)
  })
  it('asks the alternate when the primary is slow and takes the first usable answer', async () => {
    const r = await hedged(async () => (await sleep(200), 'ok-a'), async () => (await sleep(10), 'ok-b'), 30, ok)
    expect(r).toEqual({ value: 'ok-b', hedged: true, winner: 'alternate' })
  })
  it('keeps waiting for the primary when the alternate fails', async () => {
    const r = await hedged(async () => (await sleep(80), 'ok-a'), async () => 'err', 20, ok)
    expect(r).toEqual({ value: 'ok-a', hedged: true, winner: 'primary' })
  })
  it('returns the primary answer when both fail', async () => {
    const r = await hedged(async () => (await sleep(40), 'err-a'), async () => 'err-b', 10, ok)
    expect(r.value).toBe('err-a')
  })
  it('can be turned off', () => {
    expect(hedgeAfterMs({ MURMUR_INFERENCE_HEDGE_MS: 'off' })).toBeNull()
    expect(hedgeAfterMs({})).toBe(1500)
    expect(hedgeAfterMs({ MURMUR_INFERENCE_HEDGE_MS: '900' })).toBe(900)
  })
})
