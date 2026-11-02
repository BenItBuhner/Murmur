import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareTranscript } from '../src/cleanup'
import { joinPauseStops } from '../src/pause-stops'

describe('joinPauseStops', () => {
  it('joins a sentence that ends where no sentence can', () => {
    expect(joinPauseStops('I also want to. Stop measuring the day.')).toBe(
      'I also want to stop measuring the day.'
    )
    expect(joinPauseStops('It is a lot of. Stuff to do.')).toBe('It is a lot of stuff to do.')
    expect(joinPauseStops('I could. Not reproduce it on Linux.')).toBe(
      'I could not reproduce it on Linux.'
    )
  })

  it('keeps a capital it cannot vouch for', () => {
    expect(joinPauseStops('Send the budget to. Sarah by Friday.')).toBe(
      'Send the budget to Sarah by Friday.'
    )
    expect(joinPauseStops('Talk to. I mean, ask her.')).toBe('Talk to I mean, ask her.')
  })

  it('leaves real sentence ends alone', () => {
    for (const s of [
      'Nobody will. I also want to go.',
      'I wish I could. Not today though.',
      'We went with plan A. Then it rained.',
      'Wait for it... The window.',
      'Is it done? The build is red.'
    ])
      expect(joinPauseStops(s)).toBe(s)
  })

  it('changes nothing in correctly punctuated dictations', () => {
    const dir = resolve(__dirname, '../eval/long')
    const texts = readdirSync(dir).map((f) => readFileSync(resolve(dir, f), 'utf8'))
    const fixtures = JSON.parse(
      readFileSync(resolve(__dirname, '../eval/fixtures.json'), 'utf8')
    ) as Array<{ good?: string }>
    for (const f of fixtures) if (f.good) texts.push(f.good)
    for (const t of texts) expect(joinPauseStops(t)).toBe(t)
  })

  it('runs before formatting, and is a stage', () => {
    const p = prepareTranscript('I want to. Stop measuring.')
    expect(p.text).toBe('I want to stop measuring.')
    expect(p.stages).toContain('pause-stops')
  })
})
