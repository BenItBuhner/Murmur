import { describe, expect, it } from 'vitest'
import { buildSttPrompt, STT_BASE_PROMPT } from '../src/dictionary'
import { isPromptEcho, stripPromptEcho } from '../src/prompt-echo'
import { isSilenceHallucination } from '../src/hallucination'

const VOCAB = 'Vocabulary: Murmur, Wispr Flow, Claude Code. Dictation with punctuation.'

describe('stripPromptEcho', () => {
  it('drops the prompt read back after the speech (Oct 29 2026)', () => {
    expect(
      stripPromptEcho(
        'If we do the execution right we could get some major, major, major. Dictation with punctuation.',
        VOCAB
      )
    ).toBe('If we do the execution right we could get some major, major, major.')
  })

  it('drops a transcript that is only the prompt', () => {
    expect(stripPromptEcho('Dictation with punctuation.', VOCAB)).toBe('')
    expect(stripPromptEcho(' Dictation with punctuation.', STT_BASE_PROMPT)).toBe('')
    expect(stripPromptEcho('dictation with punctuation', VOCAB)).toBe('')
    expect(stripPromptEcho('With punctuation.', VOCAB)).toBe('')
  })

  it('drops the vocabulary line read back, wherever it sits', () => {
    expect(
      stripPromptEcho('Vocabulary: Murmur, Wispr Flow. Dictation with punctuation.', VOCAB)
    ).toBe('')
    expect(
      stripPromptEcho('Hello there. Vocabulary: Murmur, Wispr Flow, Claude Code. See you.', VOCAB)
    ).toBe('Hello there. See you.')
  })

  it('keeps sentences the speaker could have said', () => {
    for (const t of [
      'Murmur, Wispr Flow.',
      'Wispr Flow.',
      'Claude Code is great.',
      'We need dictation with punctuation in the app.',
      'Dictation with punctuation is the goal.',
      'Punctuation matters.',
      'The vocabulary list is long.',
      'Dictation.'
    ])
      expect(stripPromptEcho(t, VOCAB)).toBe(t)
  })

  it('keeps everything when no prompt was sent', () => {
    expect(stripPromptEcho('Dictation with punctuation.', undefined)).toBe(
      'Dictation with punctuation.'
    )
    expect(stripPromptEcho('Dictation with punctuation.', '')).toBe('Dictation with punctuation.')
  })

  it('turns a lone mark into nothing', () => {
    expect(stripPromptEcho('.', VOCAB)).toBe('')
    expect(stripPromptEcho(' . ', undefined)).toBe('')
    expect(stripPromptEcho('...', undefined)).toBe('')
    expect(stripPromptEcho('', VOCAB)).toBe('')
  })

  it('works with the prompt the app builds', () => {
    const prompt = buildSttPrompt([
      { word: 'Convex', aliases: [] },
      { word: 'Bennett', aliases: [] }
    ])
    expect(stripPromptEcho('Ship it. Dictation with punctuation.', prompt)).toBe('Ship it.')
    expect(stripPromptEcho('Vocabulary: Convex, Bennett.', prompt)).toBe('')
    expect(stripPromptEcho('Convex, Bennett.', prompt)).toBe('Convex, Bennett.')
  })

  it('isPromptEcho needs two words of the prompt in order', () => {
    expect(isPromptEcho('Punctuation.', VOCAB)).toBe(false)
    expect(isPromptEcho('Punctuation with dictation.', VOCAB)).toBe(false)
    expect(isPromptEcho('Dictation with punctuation!', VOCAB)).toBe(true)
  })
})

describe('silence phrases', () => {
  it('include "The End", which a quiet clip with a vocabulary prompt comes back as', () => {
    expect(isSilenceHallucination('The End')).toBe(true)
    expect(isSilenceHallucination('The end.')).toBe(true)
    expect(isSilenceHallucination('The end of the story.')).toBe(false)
  })
})
