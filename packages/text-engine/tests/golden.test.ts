import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_PHRASES,
  COMMAND_WORDS,
  CORRECTION_PHRASES,
  ENUMERATION_PHRASES,
  ENUMERATION_WORDS,
  FOREIGN_WORDS,
  HESITATION_PHRASES,
  HESITATION_WORDS,
  alreadyClean
} from '../src/clean'
import { prepareTranscript } from '../src/cleanup'
import { applyDictionary } from '../src/dictionary'
import { digitSignature } from '../src/numbers'
import { buildFormatMessages } from '../src/prompt'
import type { DictionaryTerm, FormatContext } from '../src/types'
import { cleanModelOutput, verifyOutput } from '../src/verify'
import { contextOf, loadFixtures } from '../eval/score'

/**
 * The contract the Android port is pinned to. This file is the source of truth for the exact
 * messages the engine sends, the verdicts it reaches and the "needs no model" decisions it makes;
 * the Kotlin test in apps/android/app/src/test/.../GoldenEngineTest.kt reads the same JSON and
 * asserts its port produces byte-identical output. Regenerate with `npm run golden` after
 * changing the prompt, the verifier, the number reader or the clean-skip rules, and review the
 * diff.
 */

const GOLDEN = resolve(__dirname, '../golden/engine.golden.json')

interface PromptCase {
  name: string
  transcript: string
  context: FormatContext
  strict?: boolean
}

const PROMPT_CASES: PromptCase[] = [
  {
    name: 'minimal chat',
    transcript: 'um hello there sarah',
    context: {
      category: 'chat',
      app: 'com.Slack',
      tone: 'casual',
      dictionary: [],
      language: 'auto'
    }
  },
  {
    name: 'everything set',
    transcript: 'the budget is one million two hundred thousand dollars',
    context: {
      category: 'email',
      app: 'com.google.android.gm',
      tone: 'professional',
      language: 'de',
      dictionary: [
        { word: 'Wispr Flow', aliases: ['whisper flow', 'wisper flo', 'whisperflow'] },
        { word: 'kubectl', aliases: ['cube control'] },
        { word: 'Convex', aliases: [] }
      ],
      keepVerbatim: ['my sig', 'the usual'],
      precedingText: 'Hi Sarah,\n\nI think we should',
      instructions: 'British spelling.\nDates as ISO.'
    }
  },
  {
    name: 'strict retry in a terminal',
    transcript: 'git commit dash m fix the thing',
    context: { category: 'terminal', tone: 'neutral', dictionary: [], language: 'en' },
    strict: true
  },
  {
    name: 'long preceding text is cut to the tail',
    transcript: 'and that is all',
    context: {
      category: 'document',
      tone: 'neutral',
      dictionary: [],
      precedingText: 'x'.repeat(450) + ' tail'
    }
  }
]

const SIGNATURE_CASES = [
  'the budget is one million two hundred thousand dollars',
  'The budget is $1,200,000.',
  'version two point oh point one',
  'my number is five five five one two one two',
  '555-1212',
  'twenty twenty four',
  'five thousand five thousand',
  'one hundred one hundred',
  'three point five million',
  'ten dollars and fifty cents',
  '$10.50',
  'double oh seven',
  'March 3, 2024 at 5:30 pm',
  'first finish the deck second email the vendor',
  '1. Finish the deck\n2. Email the vendor',
  '300k and 2.5bn',
  'grand piano',
  'a hundred and twenty three'
]

const CLEAN_CASES: Array<[string, string]> = [
  ['<think>hmm</think>Hello there.', 'hello there'],
  ['```\nHello there.\n```', 'hello there'],
  ['Cleaned text: Hello there.', 'hello there'],
  ['"Hello there."', 'hello there'],
  ['Hello there.\n\nLet me know if you need anything else!', 'hello there'],
  ['**Hello** there.', 'hello there'],
  ['<think>hmm</think>```\nHello there.\n```\n\nLet me know!', 'hello there']
]

const VERIFY_CASES: Array<[string, string, { language?: string; keepVerbatim?: string[] }?]> = [
  ['wir treffen uns um zehn uhr dreißig', 'Wir treffen uns um 10:30 Uhr.', { language: 'de' }],
  ['sign it with my sig', 'Sign it with my signature.', { keepVerbatim: ['my sig'] }],
  ['the budget is one million two hundred thousand dollars', 'The budget is $1,200,000.'],
  ['five thousand five thousand', '5,000'],
  ['what time is the meeting tomorrow', 'The meeting is at 10 am.'],
  ['can you send me the report', 'Sure! Here is the report.'],
  [
    'number one finish the deck number two email the vendor',
    '1. Finish the deck\n2. Email the vendor'
  ],
  [
    'we discussed the quarterly numbers the hiring plan and the office move in some detail',
    'We talked.'
  ],
  ['hello world', '']
]

interface SkipCase {
  name: string
  transcript: string
  context: FormatContext
  maxWords?: number
}

const CHAT: FormatContext = { category: 'chat', tone: 'casual', dictionary: [], language: 'auto' }

/** Every eval fixture, plus the edges the fixtures do not reach. */
const SKIP_CASES: SkipCase[] = [
  ...loadFixtures().map((f) => ({ name: f.id, transcript: f.transcript, context: contextOf(f) })),
  { name: 'curly apostrophe', transcript: 'Let’s ship it today.', context: CHAT },
  { name: 'other bare apostrophe', transcript: "It' fine, we' see.", context: CHAT },
  { name: 'plural possessive', transcript: "The dogs' bowls are empty.", context: CHAT },
  { name: 'em dash', transcript: "Let's do it — tomorrow.", context: CHAT },
  { name: 'accented name', transcript: 'Send it to Zoë.', context: CHAT },
  { name: 'trailing off', transcript: 'See you tomorrow...', context: CHAT },
  { name: 'pause like', transcript: 'It was, like, really good.', context: CHAT },
  { name: 'verb like', transcript: 'I like the new design a lot.', context: CHAT },
  { name: 'opener', transcript: 'Okay so we ship tomorrow.', context: CHAT },
  { name: 'mid-sentence so', transcript: "It's late, so let's stop here.", context: CHAT },
  { name: 'correction without second comma', transcript: 'Send it Tuesday, no Wednesday.', context: CHAT },
  { name: 'answer no', transcript: 'No, that works for me.', context: CHAT },
  { name: 'repeated run', transcript: 'We need to, we need to ship it.', context: CHAT },
  { name: 'question then statement', transcript: 'Is it done? Yes.', context: CHAT },
  { name: 'later unmarked question', transcript: 'Thanks. Can you resend it.', context: CHAT },
  { name: 'spoken period', transcript: 'Send it today period.', context: CHAT },
  { name: 'press enter after a full stop', transcript: 'See you tomorrow. Press enter.', context: CHAT },
  { name: 'press enter without one', transcript: 'See you tomorrow press enter', context: CHAT },
  { name: 'preceding new line', transcript: 'Sounds good.', context: { ...CHAT, precedingText: 'Hi Sarah,\n\n' } },
  { name: 'preceding comma', transcript: 'Sounds good.', context: { ...CHAT, precedingText: 'Hi Sarah,' } },
  { name: 'regional english', transcript: 'Sounds good.', context: { ...CHAT, language: 'en-US' } },
  { name: 'neutral notes', transcript: 'Sounds good.', context: { ...CHAT, category: 'notes', tone: 'neutral' } },
  { name: 'raised cap', transcript: 'Please review the attached document and let me know your thoughts by tomorrow.', context: CHAT, maxWords: 20 },
  { name: 'cap of zero', transcript: 'Sounds good.', context: CHAT, maxWords: 0 }
]

interface DictionaryCase {
  name: string
  text: string
  entries: DictionaryTerm[]
}

const BENNETT: DictionaryTerm = { word: 'Bennett', aliases: ['bennet'], fuzzy: true }
const BENNETTS: DictionaryTerm = { word: 'Bennetts', aliases: ['bennets'] }
const WISPR: DictionaryTerm = { word: 'Wispr Flow', aliases: ['whisper flow'] }

/**
 * Where a term or alias ends: the boundary is letters, digits and underscore, so an apostrophe
 * (either kind) or a hyphen closes the match and the entry is corrected inside its possessive,
 * singular or plural; the punctuation after the word is kept whatever the word becomes.
 */
const DICTIONARY_CASES: DictionaryCase[] = [
  { name: 'exact alias', text: 'ask bennet about it', entries: [BENNETT] },
  { name: 'possessive of an alias', text: "that is bennet's phone", entries: [BENNETT] },
  { name: 'curly possessive of an alias', text: 'that is bennet’s phone', entries: [BENNETT] },
  { name: 'capitalized possessive', text: "Bennet's phone rang", entries: [BENNETT] },
  { name: 'possessive of a phrase alias', text: "whisper flow's new build", entries: [WISPR] },
  { name: 'curly possessive of a phrase alias', text: 'whisper flow’s new build', entries: [WISPR] },
  { name: 'plural possessive of a plural alias', text: "the bennets' house", entries: [BENNETTS] },
  { name: 'curly plural possessive of a plural alias', text: 'the bennets’ house', entries: [BENNETTS] },
  { name: 'plural possessive already canonical', text: "the Bennetts' house", entries: [BENNETTS] },
  { name: 'plural possessive of a singular alias', text: "the bennets' house", entries: [BENNETT] },
  { name: 'possessive already canonical', text: "Bennett's phone", entries: [BENNETT] },
  { name: 'quoted entry keeps its closing quote', text: "call it 'Bennet' for now", entries: [BENNETT] },
  { name: 'first half of a hyphenated name', text: 'the bennet-smith account', entries: [BENNETT] },
  { name: 'identifier is one word', text: 'bennet_id = 3', entries: [BENNETT] },
  { name: 'contraction of an entry (the apostrophe ends the word)', text: "i don't know", entries: [{ word: 'Don', aliases: [] }] },
  { name: 'straight and curly in one sentence', text: "bennet's and bennet’s", entries: [BENNETT] }
]

function build(): unknown {
  return {
    prompts: PROMPT_CASES.map((c) => ({
      name: c.name,
      transcript: c.transcript,
      context: c.context,
      strict: c.strict ?? false,
      messages: buildFormatMessages(c.transcript, c.context, { strict: c.strict })
    })),
    signatures: SIGNATURE_CASES.map((text) => ({ text, signature: digitSignature(text) })),
    clean: CLEAN_CASES.map(([output, transcript]) => ({
      output,
      transcript,
      cleaned: cleanModelOutput(output, transcript)
    })),
    verify: VERIFY_CASES.map(([transcript, output, opts]) => {
      const v = verifyOutput(transcript, output, opts)
      return { transcript, output, options: opts ?? null, ok: v.ok, reason: v.reason ?? null }
    }),
    alreadyClean: SKIP_CASES.map((c) => {
      const d = alreadyClean(prepareTranscript(c.transcript), c.context, { maxWords: c.maxWords })
      return {
        name: c.name,
        transcript: c.transcript,
        context: c.context,
        maxWords: c.maxWords ?? null,
        clean: d.clean,
        reason: d.reason ?? null
      }
    }),
    dictionary: DICTIONARY_CASES.map((c) => ({
      name: c.name,
      text: c.text,
      entries: c.entries,
      result: applyDictionary(c.text, c.entries)
    })),
    cleanLexicon: {
      hesitationWords: HESITATION_WORDS,
      hesitationPhrases: HESITATION_PHRASES,
      commandWords: COMMAND_WORDS,
      commandPhrases: COMMAND_PHRASES,
      correctionPhrases: CORRECTION_PHRASES,
      enumerationWords: ENUMERATION_WORDS,
      enumerationPhrases: ENUMERATION_PHRASES,
      foreignWords: FOREIGN_WORDS
    }
  }
}

describe('golden contract', () => {
  it('matches golden/engine.golden.json (run `npm run golden` to update)', () => {
    const actual = JSON.stringify(build(), null, 2) + '\n'
    if (process.env.UPDATE_GOLDEN || !existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true })
      writeFileSync(GOLDEN, actual)
    }
    expect(actual).toBe(readFileSync(GOLDEN, 'utf8'))
  })
})
