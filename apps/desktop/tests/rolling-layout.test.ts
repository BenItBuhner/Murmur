import { describe, expect, it } from 'vitest'
import type { LayoutResult } from '@engine'
import { RollingLayout } from '../src/main/dictation/rolling-layout'
import type { FormatOutcome } from '../src/main/inference/router'

const piece = (n: number, outcome: FormatOutcome['status']['outcome'] = 'used'): FormatOutcome => ({
  text: Array.from({ length: n }, (_, i) => `w${i}`).join(' ') + '.',
  pressEnter: false,
  llmMs: 1,
  status: { outcome, attempts: 1 },
  stages: ['llm']
})

function setup(
  answer: (text: string) => Promise<LayoutResult> = async (text) => ({
    text: `laid:${text}`,
    outcome: 'used',
    llmMs: 1
  })
) {
  const asked: string[] = []
  const roll = new RollingLayout(
    'document',
    (text) => {
      asked.push(text)
      return answer(text)
    },
    (parts) => parts.map((p) => p.text).join(' ')
  )
  return { roll, asked }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('laying out a dictation while it is spoken', () => {
  it('waits for enough words, then lays out the pieces in order', async () => {
    const { roll, asked } = setup()
    roll.settle(0, piece(80))
    expect(asked).toHaveLength(0)
    roll.settle(1, piece(80))
    await tick()
    expect(asked).toHaveLength(1)
    expect(roll.current()?.parts).toBe(2)
  })

  it('a piece not formatted yet stops the prefix there', async () => {
    const { roll, asked } = setup()
    roll.settle(1, piece(200))
    await tick()
    expect(asked).toHaveLength(0)
    roll.settle(0, 'empty')
    await tick()
    expect(asked).toHaveLength(1)
  })

  it('lays out again only after about a minute of new words, unless flushed', async () => {
    const { roll, asked } = setup()
    roll.settle(0, piece(160))
    await tick()
    roll.settle(1, piece(40))
    await tick()
    expect(asked).toHaveLength(1)
    roll.flush()
    await tick()
    expect(asked).toHaveLength(2)
    expect(roll.current()?.parts).toBe(2)
  })

  it('never waits: an answer still out leaves the one before', async () => {
    let release: (r: LayoutResult) => void = () => undefined
    const { roll } = setup((text) =>
      text.length > 1000
        ? new Promise((r) => (release = r))
        : Promise.resolve({ text: `laid:${text}`, outcome: 'used', llmMs: 1 })
    )
    roll.settle(0, piece(160))
    await tick()
    roll.settle(1, piece(200))
    await tick()
    expect(roll.current()?.parts).toBe(1)
    release({ text: 'x', outcome: 'used', llmMs: 1 })
    await tick()
    expect(roll.current()?.parts).toBe(2)
  })

  it('a failed layout keeps the last good one and is not sent again for the same pieces', async () => {
    let fail = false
    const { roll, asked } = setup(async (text) =>
      fail
        ? { text, outcome: 'failed', llmMs: 1 }
        : { text: `laid:${text}`, outcome: 'used', llmMs: 1 }
    )
    roll.settle(0, piece(160))
    await tick()
    fail = true
    roll.settle(1, piece(120))
    await tick()
    await tick()
    expect(asked).toHaveLength(2)
    expect(roll.current()?.parts).toBe(1)
    roll.flush()
    await tick()
    expect(asked).toHaveLength(2)
  })

  it('a piece the formatter failed on is never laid out', async () => {
    const { roll, asked } = setup()
    roll.settle(0, piece(200, 'failed'))
    await tick()
    expect(asked).toHaveLength(0)
  })
})
