import { describe, expect, it } from 'vitest'
import {
  SttError,
  classifyStatus,
  normalizeBaseUrl,
  parseErrorBody,
  rankSpeechModels
} from '@core/stt/types'
import { findPreset, STT_PRESETS } from '@core/stt/presets'
import {
  buildCommandMessages,
  buildFormatMessages,
  maxTokensFor,
  sanitizeLlmOutput
} from '@core/text/llm-prompt'
import { classifyApp, resolveStyle } from '@core/text/app-context'
import { LANGUAGE_OPTIONS, LANGUAGES, languageLabel, languageName } from '@shared/languages'

describe('STT error parsing', () => {
  it('extracts the message and the suggested model list from a routing error', () => {
    const body = JSON.stringify({
      error: {
        message:
          "Audio model 'whisper-1' not found in routing configuration. Available audio models: complete-stt, groq-whisper, nvidia-whisper-large-v3, openai-stt",
        type: 'invalid_request_error'
      }
    })
    const parsed = parseErrorBody(body)
    expect(parsed.message).toContain('whisper-1')
    expect(parsed.suggestedModels).toEqual([
      'complete-stt',
      'groq-whisper',
      'nvidia-whisper-large-v3',
      'openai-stt'
    ])
    expect(classifyStatus(400, parsed.message)).toBe('model')
  })
  it('classifies statuses', () => {
    expect(classifyStatus(401, '')).toBe('auth')
    expect(classifyStatus(429, '')).toBe('rate-limit')
    expect(classifyStatus(503, 'All routes failed')).toBe('server')
    expect(classifyStatus(400, 'bad file')).toBe('bad-request')
    expect(new SttError('x', 'server').retryable).toBe(true)
    expect(new SttError('x', 'auth').retryable).toBe(false)
  })
  it('handles plain text bodies', () => {
    expect(parseErrorBody('Internal Server Error').message).toBe('Internal Server Error')
  })
  it('normalizes base urls and ranks speech models first', () => {
    expect(normalizeBaseUrl(' https://x.test/v1/// ')).toBe('https://x.test/v1')
    expect(rankSpeechModels(['gpt-4o', 'whisper-1', 'tts-1', 'nova-3'])).toEqual([
      'nova-3',
      'whisper-1',
      'gpt-4o',
      'tts-1'
    ])
  })
  it('has a custom preset as the fallback', () => {
    expect(findPreset('does-not-exist').id).toBe('custom')
    expect(STT_PRESETS.every((p) => p.defaultModel)).toBe(true)
  })
})

describe('LLM prompt and output guard', () => {
  it('builds a system prompt that carries dictionary, tone and app context', () => {
    const msgs = buildFormatMessages({
      raw: 'hello there',
      dictionary: [{ id: '1', word: 'Wispr Flow', aliases: [], fuzzy: false, createdAt: 0 }],
      style: { tone: 'casual' },
      app: classifyApp('Slack', 'general - Slack')
    })
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('Wispr Flow')
    expect(msgs[0].content).toContain('Casual')
    expect(msgs[0].content).toContain('chat message')
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'hello there' })
  })
  it('keeps the auto-detect language rule when no language is fixed', () => {
    const base = {
      raw: 'hello there',
      dictionary: [],
      style: { tone: 'neutral' as const },
      app: classifyApp('Slack', 'general - Slack')
    }
    for (const language of [undefined, 'auto', '', 'xx']) {
      const system = buildFormatMessages({ ...base, language })[0].content
      expect(system).toContain('Write the output in the language the speaker used.')
      expect(system).not.toContain('The speaker dictates in')
      expect(system).toContain('translate')
    }
  })
  it('pins the output to the chosen dictation language', () => {
    const system = buildFormatMessages({
      raw: 'hallo zusammen',
      dictionary: [],
      style: { tone: 'neutral' },
      app: classifyApp('Slack', 'general - Slack'),
      language: 'de'
    })[0].content
    expect(system).toContain(
      '- The speaker dictates in German. Write the output in German and never translate it into another language.'
    )
    expect(system).toContain('Treat such stray fragments as recognition errors')
    expect(system).toContain('most plausibly said in German')
    expect(system).not.toContain('Write the output in the language the speaker used.')
    // The generic rule keeps everything except the language clause, which the lines above own.
    expect(system).toContain(
      "- Preserve the speaker's words, meaning, and order. Never summarize, expand, answer, or add anything they did not say."
    )
    // Region subtags synced from another client still resolve.
    expect(
      buildFormatMessages({
        raw: 'oi',
        dictionary: [],
        style: { tone: 'neutral' },
        app: classifyApp('', ''),
        language: 'pt-BR'
      })[0].content
    ).toContain('dictates in Portuguese')
  })
  it('tells command mode which language the instruction was spoken in', () => {
    const input = {
      selection: 'Bonjour à tous',
      instruction: 'mach das förmlicher',
      app: classifyApp('Code.exe', 'notes.md - Code'),
      dictionary: []
    }
    const auto = buildCommandMessages(input)[0].content
    expect(auto).toContain('- Keep the original language unless asked to translate.')
    const fixed = buildCommandMessages({ ...input, language: 'de' })[0].content
    expect(fixed).toContain('The user speaks German, so the instruction is in German.')
    expect(fixed).toContain(
      'Keep the text in its original language unless the instruction asks to translate.'
    )
    expect(fixed).not.toContain('- Keep the original language unless asked to translate.')
  })
  it('accepts a faithful rewrite', () => {
    const r = sanitizeLlmOutput(
      'Hey, can you send the report to John on Wednesday? Thanks.',
      'um hey can you uh send the report to john on tuesday no wednesday thanks'
    )
    expect(r.ok).toBe(true)
    expect(r.text.startsWith('Hey')).toBe(true)
  })
  it('strips fences, quotes and labels', () => {
    expect(sanitizeLlmOutput('```\nHello world.\n```', 'hello world').text).toBe('Hello world.')
    expect(sanitizeLlmOutput('"Hello world."', 'hello world').text).toBe('Hello world.')
    expect(sanitizeLlmOutput('Cleaned text: Hello world.', 'hello world').text).toBe('Hello world.')
  })
  it('rejects answers, commentary and runaway length', () => {
    expect(sanitizeLlmOutput("Sure! Here's the cleaned text: Hello.", 'hello').ok).toBe(false)
    expect(
      sanitizeLlmOutput('The capital of France is Paris.', 'what is the capital of france').ok
    ).toBe(false)
    expect(sanitizeLlmOutput('', 'hello there friend').ok).toBe(false)
    const raw = 'one two three four five six seven eight'
    expect(sanitizeLlmOutput('one', raw).ok).toBe(false)
    expect(sanitizeLlmOutput(`${raw} ${raw} ${raw}`, raw).ok).toBe(false)
  })
  it('never starves reasoning models of completion tokens', () => {
    expect(maxTokensFor('short')).toBe(768)
    expect(maxTokensFor(Array(400).fill('word').join(' '))).toBe(1792)
    expect(maxTokensFor(Array(5000).fill('word').join(' '))).toBe(4096)
  })
  it('flags an answered question and a diverged rewrite', () => {
    expect(sanitizeLlmOutput('Paris is the capital.', 'what is the capital of france').ok).toBe(
      false
    )
    expect(
      sanitizeLlmOutput('What is the capital of France?', 'what is the capital of france').ok
    ).toBe(true)
    expect(
      sanitizeLlmOutput(
        'The weather will be sunny tomorrow with mild winds.',
        'please send the invoice to the client by friday'
      ).ok
    ).toBe(false)
  })
})

describe('app context', () => {
  it('classifies apps and resolves tone', () => {
    expect(classifyApp('slack.exe').category).toBe('chat')
    expect(classifyApp('Code.exe', 'main.ts - project').category).toBe('code')
    expect(classifyApp('chrome.exe', 'Inbox - Gmail').category).toBe('email')
    expect(classifyApp('notepad.exe').category).toBe('unknown')
    expect(resolveStyle('auto', [], classifyApp('outlook.exe')).tone).toBe('professional')
    expect(resolveStyle('auto', [], classifyApp('discord.exe')).tone).toBe('casual')
    expect(resolveStyle('professional', [], classifyApp('discord.exe')).tone).toBe('professional')
    const rules = [{ id: 'r', match: 'discord', tone: 'neutral' as const }]
    expect(resolveStyle('auto', rules, classifyApp('Discord.exe')).tone).toBe('neutral')
  })
})

describe('dictation languages', () => {
  it('uses unique two-letter codes every speech provider accepts, sorted by name', () => {
    const codes = LANGUAGES.map((l) => l.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.every((c) => /^[a-z]{2}$/.test(c))).toBe(true)
    const names = LANGUAGES.map((l) => l.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')))
    expect(LANGUAGE_OPTIONS[0]).toEqual({ code: 'auto', name: 'Auto-detect' })
    expect(LANGUAGE_OPTIONS).toHaveLength(LANGUAGES.length + 1)
  })
  it('resolves names for the prompt and labels for the picker', () => {
    expect(languageName('de')).toBe('German')
    expect(languageName(' EN ')).toBe('English')
    expect(languageName('pt-BR')).toBe('Portuguese')
    expect(languageName('zh_TW')).toBe('Chinese')
    expect(languageName('auto')).toBeUndefined()
    expect(languageName('')).toBeUndefined()
    expect(languageName(undefined)).toBeUndefined()
    expect(languageName('xx')).toBeUndefined()
    expect(languageLabel('auto')).toBe('Auto-detect')
    expect(languageLabel('')).toBe('Auto-detect')
    expect(languageLabel('fr')).toBe('French')
    expect(languageLabel('xx')).toBe('xx')
  })
})
