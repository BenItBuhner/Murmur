import { describe, expect, it } from 'vitest'
import { sttLanguageField } from '../src/languages'

describe('sttLanguageField', () => {
  it('sends gpt-transcribe the list field and everything else the singular one', () => {
    // OpenAI's speech-to-text guide: for gpt-transcribe, `languages` replaces `language`.
    expect(sttLanguageField('gpt-transcribe')).toBe('languages[]')
    expect(sttLanguageField(' GPT-Transcribe ')).toBe('languages[]')
    // Dated snapshots of the same family, when OpenAI publishes them.
    expect(sttLanguageField('gpt-transcribe-2026-08-26')).toBe('languages[]')
    // The models it replaces, and every other OpenAI-compatible server, take `language`.
    expect(sttLanguageField('whisper-1')).toBe('language')
    expect(sttLanguageField('gpt-4o-mini-transcribe')).toBe('language')
    expect(sttLanguageField('gpt-4o-transcribe')).toBe('language')
    expect(sttLanguageField('whisper-large-v3-turbo')).toBe('language')
    expect(sttLanguageField('voxtral-mini-latest')).toBe('language')
    // The realtime model is not a file-transcription model; an id that only shares the prefix
    // is not the family either.
    expect(sttLanguageField('gpt-live-transcribe')).toBe('language')
    expect(sttLanguageField('gpt-transcriber')).toBe('language')
    expect(sttLanguageField('')).toBe('language')
  })
})
