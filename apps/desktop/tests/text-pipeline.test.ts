import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { classifyApp, resolveStyle } from '@core/text/app-context'
import {
  applyLineCommands,
  applyLiteralPunctuation,
  applyScratchThat,
  applySpokenQuotes,
  extractPressEnter
} from '@core/text/commands'
import { applySelfCorrections } from '@core/text/corrections'
import { STT_BASE_PROMPT, applyDictionary, buildSttPrompt, soundKey } from '@core/text/dictionary'
import { collapseRepeats, removeFillers } from '@core/text/fillers'
import { capitalizeSentences, fixPunctuationSpacing } from '@core/text/format'
import { runPipeline, type PipelineOptions } from '@core/text/pipeline'
import { expandSnippets } from '@core/text/snippets'
import { editDistance } from '@core/text/util'

const FILLERS = ['um', 'uh', 'uhm', 'erm', 'hmm', 'mhm']

const opts: PipelineOptions = {
  removeFillers: true,
  fillerWords: FILLERS,
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
  dictionary: [
    {
      id: '1',
      word: 'Wispr Flow',
      aliases: ['whisper flow', 'wisper flow'],
      fuzzy: false,
      createdAt: 0
    },
    {
      id: '2',
      word: 'kubectl',
      aliases: ['cube control', 'cube cuttle'],
      fuzzy: false,
      createdAt: 0
    },
    { id: '3', word: 'Bennett', aliases: [], fuzzy: true, createdAt: 0 },
    { id: '4', word: 'Anthropic', aliases: [], fuzzy: false, createdAt: 0 }
  ],
  snippets: [
    { id: 's1', trigger: 'my email', content: 'ben@example.com', createdAt: 0 },
    {
      id: 's2',
      trigger: 'booking link',
      content: 'Grab a time here: https://cal.com/ben/30min',
      createdAt: 0
    }
  ],
  snippetContext: { now: new Date(2026, 8, 3, 15, 4) }
}

describe('filler removal', () => {
  it('removes mid-sentence fillers wrapped in commas', () => {
    expect(removeFillers('I think, um, that we should go.', FILLERS)).toBe(
      'I think that we should go.'
    )
    expect(removeFillers('So, uh, can you send it?', FILLERS)).toBe('So, can you send it?')
  })
  it('removes sentence-initial fillers and re-capitalizes', () => {
    expect(removeFillers('Um, so we left early.', FILLERS)).toBe('So we left early.')
    expect(removeFillers('Uh yeah that works. Um, tomorrow is fine.', FILLERS)).toBe(
      'Yeah that works. Tomorrow is fine.'
    )
  })
  it('keeps sentence-ending punctuation attached to a filler', () => {
    expect(removeFillers('That is the plan, um. Let me know.', FILLERS)).toBe(
      'That is the plan. Let me know.'
    )
  })
  it('does not touch words that merely contain a filler', () => {
    expect(removeFillers('The umbrella is under the hummus.', FILLERS)).toBe(
      'The umbrella is under the hummus.'
    )
    expect(removeFillers("I'm here", ['m'])).toBe("I'm here")
  })
  it('collapses stutters', () => {
    expect(collapseRepeats('I I think the the report is is ready')).toBe(
      'I think the report is ready'
    )
    expect(collapseRepeats('No, no, no')).toBe('No, no, no')
  })
})

describe('spoken commands', () => {
  it('handles new line and new paragraph', () => {
    expect(
      applyLineCommands('Hi Sarah, new line, thanks for the update. New paragraph. Talk soon')
    ).toBe('Hi Sarah\nThanks for the update.\n\nTalk soon')
    expect(applyLineCommands('First point. Newline second point')).toBe(
      'First point.\nSecond point'
    )
  })
  it('detects press enter at the end only', () => {
    expect(extractPressEnter('Sounds good, see you then. Press enter.')).toEqual({
      text: 'Sounds good, see you then.',
      pressEnter: true
    })
    expect(extractPressEnter('sure thing send it')).toEqual({
      text: 'sure thing',
      pressEnter: true
    })
    expect(extractPressEnter('Press enter to continue the wizard')).toEqual({
      text: 'Press enter to continue the wizard',
      pressEnter: false
    })
  })
  it('scratch that removes the previous phrase', () => {
    expect(applyScratchThat('Send the file tomorrow. Actually, scratch that. Send it today.')).toBe(
      'Send it today.'
    )
    expect(applyScratchThat('We could meet at noon, scratch that, at one.')).toBe('At one.')
    expect(applyScratchThat('The meeting is Monday. Delete that.')).toBe('')
    expect(applyScratchThat('Hello world. This is fine. Scratch that.')).toBe('Hello world.')
  })
  it('literal question and exclamation marks', () => {
    expect(applyLiteralPunctuation('Are you coming question mark')).toBe('Are you coming?')
    expect(applyLiteralPunctuation('Do it now, exclamation point.')).toBe('Do it now!')
  })
  it('turns spoken quote commands into quotation marks', () => {
    expect(applySpokenQuotes('he said quote I will be late end quote and left')).toBe(
      'he said "I will be late" and left'
    )
    expect(applySpokenQuotes('She told me, quote, do not touch that, end quote.')).toBe(
      'She told me, "Do not touch that".'
    )
    expect(applySpokenQuotes('the subject is quote weekly update unquote, then the body')).toBe(
      'the subject is "weekly update", then the body'
    )
    expect(applySpokenQuotes('open quote yes close quote')).toBe('"Yes"')
    expect(applySpokenQuotes('reply with quote sounds good? end quote only')).toBe(
      'reply with "sounds good?" only'
    )
    // "quote unquote X" is the spoken way of putting X in scare quotes.
    expect(applySpokenQuotes('the quote unquote expert showed up')).toBe('the "expert" showed up')
  })
  it('leaves the noun quote alone', () => {
    expect(applySpokenQuotes('I got a quote from the plumber')).toBe(
      'I got a quote from the plumber'
    )
    expect(applySpokenQuotes('end quote')).toBe('end quote')
    expect(applySpokenQuotes('quote unquote')).toBe('quote unquote')
    // The noun and then a real quotation: only the pair converts.
    expect(applySpokenQuotes('a quote. quote no way end quote was the answer')).toBe(
      'a quote. "No way" was the answer'
    )
  })
})

describe('self corrections', () => {
  it('replaces the corrected span', () => {
    expect(applySelfCorrections("Let's meet on Tuesday, no, Wednesday at 5.")).toBe(
      "Let's meet on Wednesday at 5."
    )
    expect(applySelfCorrections('Send it to John, I mean, Jane and copy Sam.')).toBe(
      'Send it to Jane and copy Sam.'
    )
    expect(applySelfCorrections("I'll be there at 5, sorry, 6 pm.")).toBe("I'll be there at 6 pm.")
  })
  it('handles multi-word replacements and sentence starts', () => {
    expect(applySelfCorrections('Next week, no wait, next month works.')).toBe('Next month works.')
  })
  it('aligns on a repeated anchor word', () => {
    expect(applySelfCorrections('Meet me Tuesday at 5, no, Tuesday at 6.')).toBe(
      'Meet me Tuesday at 6.'
    )
    expect(applySelfCorrections('The budget is 40k, sorry, 45k for Q3.')).toBe(
      'The budget is 45k for Q3.'
    )
  })
  it('ignores negations and plain uses of no', () => {
    expect(applySelfCorrections('There is no way, honestly.')).toBe('There is no way, honestly.')
    expect(applySelfCorrections('Send it Tuesday, not Wednesday.')).toBe(
      'Send it Tuesday, not Wednesday.'
    )
  })
  it('does not read a repeated no as a correction', () => {
    expect(applySelfCorrections('No, no, no, that is wrong.')).toBe('No, no, no, that is wrong.')
    expect(applySelfCorrections('Oh no, no, no, no, not again')).toBe(
      'Oh no, no, no, no, not again'
    )
    // ...but a genuine correction right after one still works.
    expect(applySelfCorrections('No, no, Tuesday, no, Wednesday.')).toBe('No, no, Wednesday.')
  })
})

describe('dictionary', () => {
  it('replaces exact words and aliases with canonical spelling', () => {
    expect(applyDictionary('I use whisper flow and cube control every day', opts.dictionary)).toBe(
      'I use Wispr Flow and kubectl every day'
    )
    expect(applyDictionary('Kubectl get pods', opts.dictionary)).toBe('kubectl get pods')
  })
  it('fuzzy-corrects capitalized near-misses and opted-in terms', () => {
    expect(applyDictionary('Ask Bennet about it', opts.dictionary)).toBe('Ask Bennett about it')
    expect(applyDictionary('The Antropic paper', opts.dictionary)).toBe('The Anthropic paper')
    expect(applyDictionary('lowercase antropic stays', opts.dictionary)).toBe(
      'lowercase antropic stays'
    )
  })
  it('does not rewrite unrelated words', () => {
    expect(applyDictionary('Bonnets are hats', opts.dictionary)).toBe('Bonnets are hats')
    // Same consonants as Bennett, different vowel: a different name, not a mis-hearing.
    expect(applyDictionary('Ask Bonnet about it', opts.dictionary)).toBe('Ask Bonnet about it')
    expect(applyDictionary('The water flow is fine', opts.dictionary)).toBe(
      'The water flow is fine'
    )
  })
  it('matches multi-word terms by sound, however the recognizer split or spelt them', () => {
    // Not an alias: only the sound matches.
    expect(applyDictionary('I use Wisper Flo every day', opts.dictionary)).toBe(
      'I use Wispr Flow every day'
    )
    expect(applyDictionary('please implement this in whisperflow', opts.dictionary)).toBe(
      'please implement this in Wispr Flow'
    )
    expect(applyDictionary('Whisper Floh is great', opts.dictionary)).toBe('Wispr Flow is great')
    expect(applyDictionary('run kube control get pods', opts.dictionary)).toBe(
      'run kubectl get pods'
    )
    // Punctuation between the words means they were not spoken as one term.
    expect(applyDictionary('a whisper, flow of air', opts.dictionary)).toBe(
      'a whisper, flow of air'
    )
    // Already canonical text is left alone, and its neighbours are never swallowed into it.
    expect(applyDictionary('Wispr Flow rocks', opts.dictionary)).toBe('Wispr Flow rocks')
    expect(applyDictionary('Also cc Wispr Flow support', opts.dictionary)).toBe(
      'Also cc Wispr Flow support'
    )
    expect(applyDictionary('See Whisper Flow support', opts.dictionary)).toBe(
      'See Wispr Flow support'
    )
  })
  it('corrects single words by sound only for names and opted-in terms', () => {
    const dict = [
      { id: 'a', word: 'Convex', aliases: [], fuzzy: false, createdAt: 0 },
      { id: 'b', word: 'Wispr', aliases: [], fuzzy: false, createdAt: 0 }
    ]
    expect(applyDictionary('we moved to Konvex', dict)).toBe('we moved to Convex')
    expect(applyDictionary('the Whisper team', dict)).toBe('the Wispr team')
    // Lower-case ordinary words never get pulled into a non-fuzzy term.
    expect(applyDictionary('she began to whisper', dict)).toBe('she began to whisper')
    expect(applyDictionary('a convex lens', dict)).toBe('a Convex lens')
  })
  it('ignores phrases with too little sound to be safe', () => {
    const dict = [{ id: 'g', word: 'Go To', aliases: [], fuzzy: true, createdAt: 0 }]
    expect(applyDictionary('I got it', dict)).toBe('I got it')
    expect(applyDictionary('please go to the store', dict)).toBe('please Go To the store')
  })
  it('sound keys collapse spelling variants of the same word', () => {
    expect(soundKey('whisper')).toBe(soundKey('Wispr'))
    expect(soundKey('Bennett')).toBe(soundKey('bennet'))
    expect(soundKey('Konvex')).toBe(soundKey('convex'))
    expect(soundKey('flow')).toBe(soundKey('flo'))
    expect(soundKey('kube')).toBe(soundKey('cube'))
    expect(soundKey('night')).toBe(soundKey('nite'))
    expect(soundKey('cat')).not.toBe(soundKey('dog'))
    // Words that dissolve entirely ("why") never match anything.
    expect(soundKey('why')).toBe('')
    expect(soundKey('')).toBe('')
    expect(
      applyDictionary('why not', [{ id: 'w', word: 'Wye', aliases: [], fuzzy: true, createdAt: 0 }])
    ).toBe('why not')
  })
  it('builds a bounded STT prompt that never ends with a vocabulary term', () => {
    const p = buildSttPrompt(opts.dictionary, ['my email'])
    expect(p).toContain('Wispr Flow')
    expect(p).toContain('kubectl')
    expect(p).toContain('my email')
    expect(p.length).toBeLessThan(600)
    // Whisper reads the prompt as the previous segment: a term at the very end teaches it that
    // the transcript ends right after that term is spoken.
    expect(p.startsWith('Vocabulary: Wispr Flow')).toBe(true)
    expect(p.endsWith(STT_BASE_PROMPT)).toBe(true)
    expect(buildSttPrompt([])).toBe('Dictation with punctuation.')
    const long = buildSttPrompt(
      Array.from({ length: 200 }, (_, i) => ({
        id: String(i),
        word: `term${i}`,
        aliases: [],
        fuzzy: false,
        createdAt: 0
      }))
    )
    expect(long.length).toBeLessThanOrEqual(600)
    expect(long.endsWith(STT_BASE_PROMPT)).toBe(true)
  })
  it('edit distance handles transpositions', () => {
    expect(editDistance('bennet', 'bennett')).toBe(1)
    expect(editDistance('recieve', 'receive')).toBe(1)
    expect(editDistance('abc', 'xyz', 1)).toBeGreaterThan(1)
  })
})

describe('snippets', () => {
  it('expands triggers with optional insert prefix and placeholders', () => {
    const r = expandSnippets('You can reach me at insert my email.', opts.snippets)
    expect(r.text).toBe('You can reach me at ben@example.com')
    expect(r.expanded).toEqual(['my email'])
  })
  it('fills date placeholders', () => {
    const r = expandSnippets(
      'today is the day',
      [{ id: 'x', trigger: 'the day', content: '{day}', createdAt: 0 }],
      { now: new Date(2026, 8, 3) }
    )
    expect(r.text).toBe('today is Thursday')
  })
})

describe('formatting', () => {
  it('fixes spacing around punctuation', () => {
    expect(fixPunctuationSpacing('Hello ,world .How are you ?')).toBe('Hello, world. How are you?')
    expect(fixPunctuationSpacing('Wait... what?!')).toBe('Wait... what?!')
  })
  it('capitalizes sentences and standalone i', () => {
    expect(capitalizeSentences('hello there. how are you? i am fine')).toBe(
      'Hello there. How are you? I am fine'
    )
    expect(capitalizeSentences('e.g. this stays')).toBe('E.g. this stays')
  })
})

describe('full pipeline', () => {
  it('cleans a realistic dictation end to end', () => {
    const raw =
      'um so hey Sarah, uh, can you send the the report to John on Tuesday, no, Wednesday? new line also cc whisper flow support. press enter'
    const r = runPipeline(raw, opts)
    expect(r.text).toBe(
      'So hey Sarah, can you send the report to John on Wednesday?\nAlso cc Wispr Flow support. '
    )
    expect(r.pressEnter).toBe(true)
    expect(r.stages).toEqual(
      expect.arrayContaining([
        'press-enter',
        'line-commands',
        'fillers',
        'repeats',
        'self-corrections',
        'dictionary'
      ])
    )
    expect(r.wordCount).toBe(17)
  })
  it('returns empty for meaningless input and never adds trailing space then', () => {
    const r = runPipeline(' . ', opts)
    expect(r.empty).toBe(true)
    expect(r.text).toBe('')
  })
  it('does not add trailing space after newline and respects the setting', () => {
    expect(runPipeline('Hello new line', opts).text).toBe('Hello\n')
    expect(runPipeline('Hello there', { ...opts, trailingSpace: false }).text).toBe('Hello there')
  })
  it('snippet content is not re-capitalized', () => {
    expect(runPipeline('my email', opts).text).toBe('ben@example.com ')
  })
  it('removes hesitation phrases, repeated phrases and hanging conjunctions', () => {
    const r = runPipeline(
      'so I think, you know, we should, we should ship it on, um, friday at five pm and',
      opts
    )
    expect(r.text).toBe('So I think we should ship it on friday at 5 pm ')
    expect(r.stages).toEqual(
      expect.arrayContaining(['hesitations', 'repeats', 'fillers', 'numbers'])
    )
  })
  it('turns spoken enumerations into lists and reports the intent', () => {
    const r = runPipeline(
      'here are three things for today, first finish the deck, second email the vendor about pricing, and third book the flights',
      opts
    )
    expect(r.text).toBe(
      'Here are three things for today:\n1. Finish the deck\n2. Email the vendor about pricing\n3. Book the flights\n'
    )
    expect(r.hints.listApplied).toBe(true)
    expect(r.stages).toContain('lists')
  })
  it('honours spoken list requests and strips the instruction', () => {
    const r = runPipeline('make this a bulleted list: milk, eggs and bread', opts)
    expect(r.text).toBe('- Milk\n- Eggs\n- Bread\n')
    expect(r.hints.list.requested).toBe('bullets')
    expect(r.hints.list.explicit).toBe(true)
  })
  it('keeps prose as prose when lists are off but still reports the request', () => {
    const r = runPipeline('make this a bulleted list: milk, eggs and bread', {
      ...opts,
      lists: 'off'
    })
    expect(r.text).toBe('Make this a bulleted list: milk, eggs and bread ')
    expect(r.hints.list.requested).toBe('bullets')
  })
  it('converts numbers by context and flags questions', () => {
    expect(
      runPipeline('the budget is twenty five thousand dollars for version two point three', opts)
        .text
    ).toBe('The budget is $25,000 for version 2.3 ')
    expect(runPipeline('I have five apples', opts).text).toBe('I have five apples ')
    expect(runPipeline('I have five apples', { ...opts, numbers: 'all' }).text).toBe(
      'I have 5 apples '
    )
    const q = runPipeline('what time is the meeting tomorrow', opts)
    expect(q.hints.isQuestion).toBe(true)
  })
  it('keeps emphasis and feeling through the whole pipeline', () => {
    expect(runPipeline('fuck, fuck, fuck. this is so broken', opts).text).toBe(
      'Fuck, fuck, fuck. This is so broken '
    )
    expect(runPipeline('no, no, no, that is wrong', opts).text).toBe('No, no, no, that is wrong ')
    expect(runPipeline('go go go go', opts).text).toBe('Go go go go ')
    expect(runPipeline('I, I think it was very, very slow', opts).text).toBe(
      'I think it was very, very slow '
    )
  })
  it('never de-duplicates or shortens numbers', () => {
    expect(runPipeline('my number is five five five one two one two', opts).text).toBe(
      'My number is 5551212 '
    )
    expect(runPipeline('the pin is zero zero zero zero', opts).text).toBe('The pin is 0000 ')
    expect(runPipeline('one zero zero zero, one zero zero zero', opts).text).toBe('1000, 1000 ')
    expect(runPipeline('version two point zero point zero', opts).text).toBe('Version 2.0.0 ')
    expect(runPipeline('the code is A1 A1 B2 B2', opts).text).toBe('The code is A1 A1 B2 B2 ')
    expect(runPipeline('it costs 1,000,000 1,000,000', opts).text).toBe(
      'It costs 1,000,000 1,000,000 '
    )
    expect(runPipeline('agent zero zero seven, zero zero seven', opts).text).toBe('Agent 007, 007 ')
  })
  it('writes spoken quotations with quotation marks', () => {
    expect(runPipeline('she said quote I will be late end quote and left', opts).text).toBe(
      'She said "I will be late" and left '
    )
    expect(
      runPipeline('the subject line should be quote weekly update question mark end quote', opts)
        .text
    ).toBe('The subject line should be "weekly update?" ')
  })
  it('thorough levels catch false starts and openers', () => {
    const r = runPipeline('okay so, I want to, I need to go to the store', {
      ...opts,
      hesitations: 'thorough',
      repetitionScope: 'thorough'
    })
    expect(r.text).toBe('I need to go to the store ')
  })
})

describe('app context policy', () => {
  const formatting = defaultSettings().formatting
  it('turns lists off and digits on for code and terminals', () => {
    const style = resolveStyle(formatting, classifyApp('Code.exe', 'main.ts - project'))
    expect(style).toMatchObject({
      lists: 'off',
      numbers: 'all',
      freedom: 'strict',
      structure: 'keep'
    })
    expect(resolveStyle(formatting, classifyApp('slack', '')).lists).toBe('auto')
  })
  it('lets a matching rule override category defaults and merges instructions', () => {
    const withRule = {
      ...formatting,
      llm: { ...formatting.llm, instructions: 'Use British spelling.' },
      appRules: [
        {
          id: 'r',
          match: 'code',
          tone: 'auto' as const,
          lists: 'auto' as const,
          freedom: 'natural' as const,
          instructions: 'Keep identifiers lower-case.'
        }
      ]
    }
    const style = resolveStyle(withRule, classifyApp('Code.exe', ''))
    expect(style.lists).toBe('auto')
    expect(style.freedom).toBe('natural')
    expect(style.instructions).toBe('Use British spelling.\n\nKeep identifiers lower-case.')
    expect(style.rule?.match).toBe('code')
  })
})
