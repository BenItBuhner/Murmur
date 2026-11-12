import { describe, expect, it } from 'vitest'
import { addedRun, copiedContext, verifyOutput } from '../src/verify'

// Nov 12 2026: a long dictation into a chat box that already held "## Aggregating All Demo
// Videos/Concepts We Have Made For Our Projects". The model invented a placeholder line and copied
// the heading into its answer, which was typed under the heading.
const SAID =
  "We want to show and surface every single most recent demonstration or announcement video, both from the Claude Code projects as well as our various bots, notably the designer of course, as I want to be able to give feedback on them and right now we're missing most of these and I want to actually see them."
const HEADING = '## Aggregating All Demo Videos/Concepts We Have Made For Our Projects'
const CLEAN =
  "We want to show and surface every single most recent demonstration or announcement video, both from the Claude Code projects as well as our various bots, notably the designer, of course, as I want to be able to give feedback on them. Right now we're missing most of these, and I want to actually see them."

describe('text the speaker never said', () => {
  it('rejects an invented placeholder line', () => {
    const bad = `Placeholder Summary [Add real written content later about me and whatnot else.]\n\n${CLEAN}`
    expect(addedRun(SAID, bad)).toBeGreaterThanOrEqual(5)
    expect(verifyOutput(SAID, bad).reason).toBe('added')
  })

  it('rejects the heading before the cursor copied into the answer', () => {
    const bad = `Aggregating All Demo Videos/Concepts We Have Made For Our Projects ${CLEAN}`
    expect(copiedContext(SAID, bad, HEADING).length).toBeGreaterThan(0)
    expect(verifyOutput(SAID, bad, { precedingText: HEADING }).reason).toBe('copied-context')
  })

  it('rejects the full answer from that dictation', () => {
    const bad = `Placeholder Summary [Add real written content later about me and whatnot else.]\n\nAggregating All Demo Videos/Concepts We Have Made For Our Projects ${CLEAN}`
    expect(verifyOutput(SAID, bad, { precedingText: HEADING }).ok).toBe(false)
  })

  it('accepts a faithful cleanup, with or without the context', () => {
    expect(addedRun(SAID, CLEAN)).toBeLessThan(5)
    expect(verifyOutput(SAID, CLEAN, { precedingText: HEADING }).ok).toBe(true)
  })

  it('accepts words the speaker repeated from the text before the cursor', () => {
    const said = 'we want to aggregate all demo videos for our projects this week'
    const out = 'We want to aggregate all demo videos for our projects this week.'
    expect(verifyOutput(said, out, { precedingText: 'Aggregate all demo videos for our projects' }).ok).toBe(true)
  })
})
