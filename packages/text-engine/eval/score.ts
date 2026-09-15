import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  AppCategory,
  DictionaryTerm,
  FormatContext,
  FormatResult,
  ResolvedTone
} from '../src/types'
import { digitSignature } from '../src/numbers'
import { verifyOutput } from '../src/verify'

/**
 * The evaluation corpus and its scoring. A fixture is a realistic transcript, the context the
 * engine would see, and what the inserted text must (and must not) contain. `good` is an answer a
 * good model gives (it doubles as the specification and drives the offline run); `bad` are
 * answers the engine must never let through.
 *
 * Scoring is deliberately property-based: several renderings of a number or a list are fine, a
 * changed number, a dropped negation or an answered question is not.
 */

export interface FixtureContext {
  category: AppCategory
  tone: ResolvedTone
  app?: string
  language?: string
  precedingText?: string
  instructions?: string
  dictionary?: DictionaryTerm[]
  keepVerbatim?: string[]
}

export interface Expectation {
  contains?: string[]
  notContains?: string[]
  /** JavaScript regex source, tested with the `m` flag. */
  matches?: string
  notMatches?: string
  minLines?: number
  maxLines?: number
  pressEnter?: boolean
  /** Only the number invariant is checked (the wording is free). */
  numbersOnly?: boolean
}

export interface Fixture {
  id: string
  transcript: string
  context: FixtureContext
  expect: Expectation
  good: string
  bad: string[]
}

export function loadFixtures(): Fixture[] {
  return JSON.parse(readFileSync(resolve(__dirname, 'fixtures.json'), 'utf8')) as Fixture[]
}

export function contextOf(f: Fixture): FormatContext {
  return {
    category: f.context.category,
    tone: f.context.tone,
    app: f.context.app,
    language: f.context.language ?? 'auto',
    precedingText: f.context.precedingText,
    instructions: f.context.instructions,
    dictionary: f.context.dictionary ?? [],
    keepVerbatim: f.context.keepVerbatim
  }
}

export interface Check {
  name: string
  pass: boolean
  detail?: string
}

export interface Score {
  id: string
  pass: boolean
  checks: Check[]
}

/** Score the text the engine would insert (and, when known, the whole result). */
export function scoreText(
  f: Fixture,
  text: string,
  result?: Pick<FormatResult, 'pressEnter' | 'status'>
): Score {
  const checks: Check[] = []
  const e = f.expect
  const push = (name: string, pass: boolean, detail?: string): void => {
    checks.push({ name, pass, detail })
  }
  // The invariants every answer must satisfy, whatever the fixture says.
  const invariant = verifyOutput(f.transcript, text, {
    language: f.context.language,
    keepVerbatim: f.context.keepVerbatim
  })
  push('verifier', invariant.ok, invariant.reason)
  const expected = digitSignature(f.transcript)
  const actual = digitSignature(text)
  const actualWithMarkers = digitSignature(text, false)
  const lang = (f.context.language ?? 'auto').split(/[-_]/)[0]
  const foreign = lang !== 'auto' && lang !== 'en'
  push(
    'numbers',
    foreign
      ? actual.includes(expected) || actualWithMarkers.includes(expected)
      : actual === expected || actualWithMarkers === expected,
    `${expected} vs ${actual}`
  )
  if (e.numbersOnly) return { id: f.id, pass: checks.every((c) => c.pass), checks }

  for (const s of e.contains ?? []) push(`contains ${JSON.stringify(s)}`, text.includes(s))
  for (const s of e.notContains ?? []) push(`omits ${JSON.stringify(s)}`, !text.includes(s))
  if (e.matches) push(`matches /${e.matches}/`, new RegExp(e.matches, 'm').test(text))
  if (e.notMatches) push(`never /${e.notMatches}/`, !new RegExp(e.notMatches, 'm').test(text))
  const lines = text.split('\n').filter((l) => l.trim()).length
  if (e.minLines !== undefined) push(`>= ${e.minLines} lines`, lines >= e.minLines, String(lines))
  if (e.maxLines !== undefined) push(`<= ${e.maxLines} lines`, lines <= e.maxLines, String(lines))
  if (e.pressEnter !== undefined && result)
    push('press enter', result.pressEnter === e.pressEnter, String(result.pressEnter))
  return { id: f.id, pass: checks.every((c) => c.pass), checks }
}

export function summarize(scores: Score[]): string {
  const passed = scores.filter((s) => s.pass).length
  const lines = [`${passed}/${scores.length} fixtures passed`]
  for (const s of scores) {
    if (s.pass) continue
    lines.push(`  x ${s.id}`)
    for (const c of s.checks)
      if (!c.pass) lines.push(`      - ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
  }
  return lines.join('\n')
}
