import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/settings'
import type { ChatResult } from '@core/llm/client'
import { classifyApp, resolveStyle } from '@core/text/app-context'
import { buildFormatMessages, maxTokensFor } from '@core/text/llm-prompt'
import { runPipeline, type PipelineOptions } from '@core/text/pipeline'
import {
  reviewPolicyFor,
  skipReason,
  smartFormat,
  type SmartFormatInput
} from '@core/text/smart-format'

const settings = defaultSettings()
const formatting = {
  ...settings.formatting,
  llm: { ...settings.formatting.llm, model: 'test-model', baseUrl: 'http://x' }
}
const dictionary = [
  { id: '1', word: 'kubectl', aliases: ['cube control'], fuzzy: false, createdAt: 0 }
]
const app = classifyApp('slack', '')
const style = resolveStyle(formatting, app)
const pipelineOpts: PipelineOptions = {
  removeFillers: true,
  fillerWords: formatting.fillerWords,
  hesitations: 'light',
  hesitationPhrases: [],
  collapseRepeats: true,
  repetitionScope: 'phrases',
  spokenCommands: true,
  selfCorrections: true,
  autoCapitalize: true,
  trailingSpace: true,
  pressEnterCommand: true,
  lists: 'auto',
  listStyle: 'auto',
  bulletMarker: '-',
  numbers: 'smart',
  dictionary,
  snippets: []
}
const llm = { baseUrl: 'http://x', apiKey: '', model: 'test-model', timeoutMs: 1000 }

function input(raw: string, overrides: Partial<SmartFormatInput> = {}): SmartFormatInput {
  return {
    light: runPipeline(raw, pipelineOpts),
    formatting,
    dictionary,
    style,
    app,
    llm,
    pipelineOpts,
    ...overrides
  }
}
const reply = (text: string) => async (): Promise<ChatResult> => ({
  text,
  latencyMs: 5,
  model: 'test-model',
  finishReason: 'stop'
})

describe('buildFormatMessages', () => {
  it('reflects freedom, structure, hints, dictionary and user instructions', () => {
    const light = runPipeline('what time is the meeting tomorrow', pipelineOpts)
    const messages = buildFormatMessages({
      raw: light.text.trim(),
      dictionary,
      style: { ...style, freedom: 'strict', instructions: 'Use British spelling.' },
      app,
      hints: light.hints
    })
    const system = messages[0].content
    expect(system).toContain('Do not rephrase')
    expect(system).not.toContain('Grammar slips')
    expect(system).toContain('lay the items out as a list')
    expect(system).toContain('Personal dictionary: kubectl (heard as "cube control")')
    expect(system).toContain('Never insert a dictionary term where nothing similar was said')
    expect(system).toContain('It must stay a question')
    expect(system).toContain('Use British spelling.')
    expect(system).toContain('a chat message')
    // examples come as user/assistant pairs and the transcript is the last message
    expect(messages.filter((m) => m.role === 'assistant').length).toBeGreaterThanOrEqual(3)
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: 'What time is the meeting tomorrow'
    })
  })
  it('switches rules with freedom and structure and can drop examples', () => {
    const natural = buildFormatMessages({
      raw: 'x',
      dictionary: [],
      style: { ...style, freedom: 'natural', structure: 'keep' },
      app,
      examples: false
    })
    expect(natural[0].content).toContain('Awkward or tangled phrasing')
    expect(natural[0].content).toContain('Do not create lists')
    expect(natural).toHaveLength(2)
    const technical = buildFormatMessages({
      raw: 'x',
      dictionary: [],
      style: resolveStyle(formatting, classifyApp('Windows Terminal', '')),
      app: classifyApp('Windows Terminal', '')
    })
    expect(technical[0].content).toContain('Identifiers, file names, commands')
  })
  it('bounds completion tokens', () => {
    expect(maxTokensFor('short')).toBe(768)
    expect(maxTokensFor(Array(3000).fill('word').join(' '))).toBe(4096)
  })
})

describe('smartFormat', () => {
  it('explains why the model is skipped', () => {
    expect(
      skipReason({
        ...input('hello there my friend how are you'),
        style: { ...style, mode: 'light' }
      })
    ).toBe('light mode')
    expect(skipReason(input('hi there'))).toMatch(/shorter than/)
    expect(skipReason({ ...input('hello there my friend'), llm: { ...llm, model: '' } })).toBe(
      'no model configured'
    )
    expect(skipReason(input('hello there my friend how are you'))).toBeNull()
  })
  it('uses a faithful answer and finishes it', async () => {
    const r = await smartFormat(
      input('so hey sarah can you send the report to john on tuesday no wednesday'),
      reply('Hey Sarah, can you send the report to John on Wednesday?')
    )
    expect(r.status.outcome).toBe('used')
    expect(r.result.text).toBe('Hey Sarah, can you send the report to John on Wednesday? ')
    expect(r.result.stages).toContain('llm')
  })
  it('keeps the spoken words when the model rewrites them, and reports partial', async () => {
    const r = await smartFormat(
      input('can you send the report to john on wednesday please'),
      reply('Could you send the report to John on Wednesday, please?')
    )
    expect(r.status.outcome).toBe('partial')
    expect(r.result.text).toBe('Can you send the report to John on Wednesday, please? ')
    expect(r.status.reverted).toBe(1)
  })
  it('rejects a heavy rewrite outright and keeps the deterministic text', async () => {
    const r = await smartFormat(
      input('can you send the report to john on wednesday please'),
      reply('Could you kindly forward the report to John on Wednesday?')
    )
    expect(r.status.outcome).toBe('rejected')
    expect(r.status.detail).toBe('rewrite')
    expect(r.result.text).toBe('Can you send the report to john on wednesday please ')
  })
  it('falls back to the deterministic text when the model chats or answers', async () => {
    const chatty = await smartFormat(
      input('what time is the meeting tomorrow with the team'),
      reply('The meeting is at 10 am tomorrow.')
    )
    expect(chatty.status.outcome).toBe('rejected')
    expect(chatty.status.detail).toBe('answered')
    expect(chatty.result.text).toBe('What time is the meeting tomorrow with the team ')
    const fenced = await smartFormat(
      input('hello there my friend how are you doing'),
      reply('<think>ok</think>```\nHello there, my friend. How are you doing?\n```')
    )
    expect(fenced.status.outcome).toBe('used')
    expect(fenced.result.text).toBe('Hello there, my friend. How are you doing? ')
  })
  it('degrades to the deterministic text when the request fails', async () => {
    const r = await smartFormat(input('hello there my friend how are you doing'), async () => {
      throw new Error('boom')
    })
    expect(r.status).toEqual({ outcome: 'failed', detail: 'boom' })
    expect(r.result.text).toBe('Hello there my friend how are you doing ')
  })
  it('builds the review policy from settings', () => {
    const policy = reviewPolicyFor(input('first, do this. second, do that'))
    expect(policy.droppable.has('um')).toBe(true)
    expect(policy.droppable.has('know')).toBe(true)
    expect(policy.protectedTerms.has('kubectl')).toBe(true)
    expect(policy.allowNewLines).toBe(true)
    expect(policy.preserveLayout).toBe(true)
  })
  it('protects every word of a multi-word term, but not the glue inside a name', () => {
    const policy = reviewPolicyFor(
      input('hello', {
        dictionary: [
          { id: '1', word: 'Wispr Flow', aliases: ['whisper flow'], fuzzy: false, createdAt: 0 },
          { id: '2', word: 'Bank of America', aliases: [], fuzzy: false, createdAt: 0 }
        ]
      })
    )
    expect(policy.protectedTerms.has('wispr')).toBe(true)
    expect(policy.protectedTerms.has('flow')).toBe(true)
    expect(policy.protectedTerms.has('bank')).toBe(true)
    expect(policy.protectedTerms.has('of')).toBe(false)
    expect(policy.dictionaryPhrases?.has('wispr flow')).toBe(true)
    expect(policy.dictionaryPhrases?.has('bank of america')).toBe(true)
  })
  it('lets the model repair a mangled multi-word term end to end', async () => {
    const dict = [{ id: '1', word: 'Wispr Flow', aliases: [], fuzzy: false, createdAt: 0 }]
    // "wasp or flow" does not sound like the term (different vowel), so the rules leave it; the
    // model hears it and the review must let the correction through.
    const raw = 'please implement this in a clean manner like wasp or flow does'
    const light = runPipeline(raw, { ...pipelineOpts, dictionary: dict })
    expect(light.text).toBe('Please implement this in a clean manner like wasp or flow does ')
    const r = await smartFormat(
      input(raw, { light, dictionary: dict, pipelineOpts: { ...pipelineOpts, dictionary: dict } }),
      reply('Please implement this in a clean manner, like Wispr Flow does.')
    )
    expect(r.status.outcome).toBe('used')
    expect(r.result.text).toBe('Please implement this in a clean manner, like Wispr Flow does. ')
  })
  it('rejects an answer the model could not finish', async () => {
    const r = await smartFormat(
      input('hello there my friend how are you doing today and tomorrow'),
      async () => ({
        text: 'Hello there, my friend. How are you doing today',
        latencyMs: 5,
        model: 'test-model',
        finishReason: 'length'
      })
    )
    expect(r.status).toEqual({ outcome: 'rejected', detail: 'truncated' })
    expect(r.result.text).toBe('Hello there my friend how are you doing today and tomorrow ')
  })
})
