import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { digitSignature } from '../src/numbers'
import { buildFormatMessages } from '../src/prompt'
import type { FormatContext } from '../src/types'
import { cleanModelOutput, verifyOutput } from '../src/verify'

/**
 * The contract the Android port is pinned to. This file is the source of truth for the exact
 * messages the engine sends and the verdicts it reaches; the Kotlin test in
 * apps/android/app/src/test/.../GoldenEngineTest.kt reads the same JSON and asserts its port
 * produces byte-identical output. Regenerate with `npm run golden` after changing the prompt,
 * the verifier or the number reader, and review the diff.
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
    context: { category: 'chat', app: 'com.Slack', tone: 'casual', dictionary: [], language: 'auto' }
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

const VERIFY_CASES: Array<[string, string]> = [
  ['the budget is one million two hundred thousand dollars', 'The budget is $1,200,000.'],
  ['five thousand five thousand', '5,000'],
  ['what time is the meeting tomorrow', 'The meeting is at 10 am.'],
  ['can you send me the report', 'Sure! Here is the report.'],
  ['number one finish the deck number two email the vendor', '1. Finish the deck\n2. Email the vendor'],
  ['we discussed the quarterly numbers the hiring plan and the office move in some detail', 'We talked.'],
  ['hello world', '']
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
    verify: VERIFY_CASES.map(([transcript, output]) => {
      const v = verifyOutput(transcript, output)
      return { transcript, output, ok: v.ok, reason: v.reason ?? null }
    })
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
