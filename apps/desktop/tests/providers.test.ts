import { describe, expect, it } from 'vitest'
import {
  SttError,
  classifyStatus,
  normalizeBaseUrl,
  parseErrorBody,
  rankSpeechModels
} from '@core/stt/types'
import { findPreset, STT_PRESETS } from '@core/stt/presets'
import { buildCommandMessages, classifyApp, resolveStyle, userMessage } from '@engine'
import { defaultSettings } from '@shared/settings'
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

describe('settings -> engine context', () => {
  it('resolves tone from the destination, the global setting, then a per-app rule', () => {
    const f = defaultSettings().formatting
    expect(resolveStyle(f, f.appRules, classifyApp('outlook.exe')).tone).toBe('professional')
    expect(resolveStyle(f, f.appRules, classifyApp('discord.exe')).tone).toBe('casual')
    expect(
      resolveStyle({ ...f, tone: 'professional' }, f.appRules, classifyApp('discord.exe')).tone
    ).toBe('professional')
    const appRules = [
      { id: 'r', match: 'discord', tone: 'neutral' as const, instructions: 'no emoji' }
    ]
    const styled = resolveStyle(
      { ...f, instructions: 'be brief' },
      appRules,
      classifyApp('Discord.exe')
    )
    expect(styled.tone).toBe('neutral')
    expect(styled.instructions).toBe('be brief\n\nno emoji')
    expect(styled.mode).toBe('smart')
  })
  it('classifies apps', () => {
    expect(classifyApp('slack.exe').category).toBe('chat')
    expect(classifyApp('Code.exe', 'main.ts - project').category).toBe('code')
    expect(classifyApp('chrome.exe', 'Inbox - Gmail').category).toBe('email')
    expect(classifyApp('notepad.exe').category).toBe('unknown')
  })
  it('builds the per-dictation message from settings-shaped data', () => {
    const app = classifyApp('Slack', 'general - Slack')
    const f = { ...defaultSettings().formatting, tone: 'casual' as const }
    const style = resolveStyle(f, f.appRules, app)
    const msg = userMessage('hello there', {
      category: app.category,
      app: app.app,
      tone: style.tone,
      language: 'pt-BR',
      dictionary: [{ id: '1', word: 'Wispr Flow', aliases: [], fuzzy: false, createdAt: 0 }]
    })
    expect(msg).toContain('Destination: a chat message (Slack). Tone: casual.')
    expect(msg).toContain('Language: Portuguese.')
    expect(msg).toContain('Dictionary: Wispr Flow.')
    expect(msg.endsWith('Transcript:\nhello there')).toBe(true)
  })
  it('tells command mode which language the instruction was spoken in', () => {
    const input = {
      selection: 'Bonjour à tous',
      instruction: 'mach das förmlicher',
      category: classifyApp('Code.exe', 'notes.md - Code').category,
      dictionary: []
    }
    const auto = buildCommandMessages(input)[0].content
    expect(auto).toContain('- Keep the original language unless asked to translate.')
    const fixed = buildCommandMessages({ ...input, language: 'de' })[0].content
    expect(fixed).toContain('The user speaks German, so the instruction is in German.')
    expect(fixed).not.toContain('- Keep the original language unless asked to translate.')
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
