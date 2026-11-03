import { describe, expect, it } from 'vitest'
import { finish } from '../src/cleanup'
import { resolveStyle, type StylePrefs } from '../src/context'
import { formatTranscript } from '../src/format'
import { wantsLayout } from '../src/layout'
import {
  PROFILES,
  applyCasing,
  keepParagraphs,
  layoutLine,
  profileOf,
  resolveLayout
} from '../src/profiles'
import { buildFormatMessages, userMessage } from '../src/prompt'
import type { ChatResult, FormatContext } from '../src/types'
import { repairOutput } from '../src/verify'

const prefs = (extra: Partial<StylePrefs> = {}): StylePrefs => ({
  mode: 'smart',
  tone: 'auto',
  instructions: '',
  trailingSpace: true,
  ...extra
})
const slack = { app: 'slack', title: 'general', category: 'chat' as const }
const word = { app: 'winword', title: 'Doc1', category: 'document' as const }

describe('resolveStyle with profiles', () => {
  it('defaults to the Default profile, which changes nothing', () => {
    const s = resolveStyle(prefs(), [], slack)
    expect(s.profile).toBe('default')
    expect(s.tone).toBe('casual')
    expect(s.layout).toBe('auto')
    expect(s.casing).toBe('standard')
    expect(s.grammar).toBe('polish')
  })

  it('a per-app profile wins over the global one', () => {
    const rules = [{ match: 'slack', profile: 'casual' }]
    const s = resolveStyle(prefs({ profile: 'polished' }), rules, slack)
    expect(s.profile).toBe('casual')
    expect(s.casing).toBe('lowercase')
    expect(s.tone).toBe('casual')
    const other = resolveStyle(prefs({ profile: 'polished' }), rules, word)
    expect(other.profile).toBe('polished')
    expect(other.layout).toBe('structured')
    expect(other.tone).toBe('professional')
  })

  it('tone: rule tone, then rule profile, then global tone, then global profile, then the app', () => {
    const t = (p: Partial<StylePrefs>, rule?: { tone?: 'neutral'; profile?: string }): string =>
      resolveStyle(prefs(p), rule ? [{ match: 'slack', ...rule }] : [], slack).tone
    expect(t({ profile: 'polished' }, { tone: 'neutral', profile: 'casual' })).toBe('neutral')
    expect(t({ tone: 'neutral' }, { profile: 'polished' })).toBe('professional')
    expect(t({ tone: 'neutral', profile: 'polished' })).toBe('neutral')
    expect(t({ profile: 'polished' })).toBe('professional')
    expect(t({})).toBe('casual')
    // Default picked on the rule means "adapt to this app", whatever the global profile or tone.
    expect(t({ profile: 'polished' }, { profile: 'default' })).toBe('casual')
    expect(t({ tone: 'neutral' }, { profile: 'default' })).toBe('casual')
  })

  it("the global profile's casing applies in chat; a rule's applies wherever it matches", () => {
    expect(resolveStyle(prefs({ profile: 'casual' }), [], slack).casing).toBe('lowercase')
    expect(resolveStyle(prefs({ profile: 'casual' }), [], word).casing).toBe('standard')
    const rules = [{ match: 'winword', profile: 'casual' }]
    expect(resolveStyle(prefs(), rules, word).casing).toBe('lowercase')
  })

  it('an unknown profile id (from a newer build) reads as Default', () => {
    expect(profileOf('future-profile').id).toBe('default')
    expect(resolveStyle(prefs({ profile: 'nope' }), [], word).profile).toBe('default')
  })
})

describe('layout', () => {
  it('auto: paragraphs only where documents go, lists everywhere as before', () => {
    expect(resolveLayout('auto', 'email')).toBe('balanced')
    expect(resolveLayout(undefined, 'notes')).toBe('balanced')
    expect(resolveLayout('auto', 'document')).toBe('balanced')
    expect(resolveLayout('auto', 'chat')).toBe('lists')
    expect(resolveLayout('auto', 'code')).toBe('lists')
    expect(resolveLayout('minimal', 'email')).toBe('minimal')
    expect(resolveLayout('structured', 'chat')).toBe('structured')
  })

  it('a chat prompt is unchanged; an email prompt gets the Layout line', () => {
    const chat: FormatContext = { category: 'chat', tone: 'casual', dictionary: [] }
    expect(userMessage('hi', chat)).not.toContain('Layout:')
    const email: FormatContext = { category: 'email', tone: 'professional', dictionary: [] }
    expect(userMessage('hi', email)).toContain(layoutLine('balanced'))
    expect(userMessage('hi', { ...email, layout: 'minimal' })).toContain(layoutLine('minimal'))
    expect(userMessage('hi', { ...chat, grammar: 'as-spoken' })).toContain('Grammar: as spoken.')
  })

  it('the long-dictation layout pass follows the profile', () => {
    const long = 'word '.repeat(200)
    expect(wantsLayout(long, 'email')).toBe(true)
    expect(wantsLayout(long, 'email', 'minimal')).toBe(false)
    expect(wantsLayout(long, 'chat')).toBe(false)
    // Never in chat: the pass can run at the key-up; the prompt's Layout line is all chat gets.
    expect(wantsLayout(long, 'chat', 'structured')).toBe(false)
    expect(wantsLayout(long, 'code', 'structured')).toBe(false)
  })
})

describe('keepParagraphs and repairOutput', () => {
  const said =
    'hi team quick update. the beta is out. we fixed the crash. on the budget side we are waiting. more soon'
  const answer =
    'Hi team, quick update.\n\nThe beta is out. We fixed the crash.\n\nOn the budget side, we are waiting. More soon.'

  it('gives a greeting on its own line a paragraph of its own', () => {
    expect(keepParagraphs('Hi Sam,\nThanks for the notes. I will look tonight.')).toBe(
      'Hi Sam,\n\nThanks for the notes. I will look tonight.'
    )
    expect(keepParagraphs('Hello Ms. Alvarez,\n\nThank you.')).toBe(
      'Hello Ms. Alvarez,\n\nThank you.'
    )
    // Not a greeting: a blank line inside a sentence is still joined.
    expect(keepParagraphs('We went,\n\nand then left.')).toBe('We went, and then left.')
  })

  it('keeps blank lines between sentences when the layout allows paragraphs', () => {
    expect(repairOutput(said, answer, { paragraphs: true })).toBe(answer)
  })

  it('joins them back when it does not (unchanged behaviour)', () => {
    expect(repairOutput(said, answer)).toBe(
      'Hi team, quick update. The beta is out. We fixed the crash. On the budget side, we are waiting. More soon.'
    )
  })

  it('never keeps a break inside a sentence, or a single newline', () => {
    expect(keepParagraphs('We will ship\n\non Friday. Then rest.')).toBe(
      'We will ship on Friday. Then rest.'
    )
    expect(keepParagraphs('One thing.\nAnother thing.')).toBe('One thing. Another thing.')
    expect(keepParagraphs('A.\n\n\n\nB.')).toBe('A.\n\nB.')
  })

  it('formatTranscript keeps the model paragraphs in an email and not in chat', async () => {
    const complete = async (): Promise<ChatResult> => ({ text: answer })
    const email = await formatTranscript(
      {
        transcript: said,
        mode: 'smart',
        context: { category: 'email', tone: 'professional', dictionary: [] }
      },
      complete
    )
    expect(email.status.outcome).toBe('used')
    expect(email.text).toBe(answer)
    const chat = await formatTranscript(
      {
        transcript: said,
        mode: 'smart',
        context: { category: 'chat', tone: 'casual', dictionary: [] }
      },
      complete
    )
    expect(chat.text).not.toContain('\n')
    const minimal = await formatTranscript(
      {
        transcript: said,
        mode: 'smart',
        context: { category: 'email', tone: 'professional', dictionary: [], layout: 'minimal' }
      },
      complete
    )
    expect(minimal.text).not.toContain('\n')
  })
})

describe('casing', () => {
  it('lowercase lowers sentence starts and drops the final period of a one-line message', () => {
    expect(applyCasing('Sounds good. See you at 5.', 'lowercase')).toBe('sounds good. see you at 5')
    expect(applyCasing('Hey, can you send it? Thanks!', 'lowercase')).toBe(
      'hey, can you send it? thanks!'
    )
    expect(applyCasing("Don't worry about it.", 'lowercase')).toBe("don't worry about it")
  })

  it('keeps names, I, acronyms and abbreviations', () => {
    expect(applyCasing('Sarah said yes. I think so.', 'lowercase')).toBe(
      'Sarah said yes. I think so'
    )
    expect(applyCasing("I'm in. NASA called.", 'lowercase')).toBe("I'm in. NASA called")
    expect(applyCasing('Meet at 5 p.m.', 'lowercase')).toBe('meet at 5 p.m.')
    expect(applyCasing('Wait...', 'lowercase')).toBe('wait...')
  })

  it('keeps a frequent word the text uses as a name, and dictionary words', () => {
    expect(applyCasing('Will is coming. Ask Will about it.', 'lowercase')).toBe(
      'Will is coming. ask Will about it'
    )
    expect(applyCasing('Apple shipped it.', 'lowercase', 'chat', ['Apple'])).toBe(
      'Apple shipped it'
    )
    const out = finish('Apple shipped it.', {
      category: 'chat',
      dictionary: [{ word: 'Apple', aliases: [] }],
      trailingSpace: false,
      casing: 'lowercase'
    })
    expect(out.text).toBe('Apple shipped it')
  })

  it('keeps the period on multi-line text and leaves standard casing alone', () => {
    expect(applyCasing('First line.\nSecond line.', 'lowercase')).toBe('first line.\nsecond line.')
    expect(applyCasing('Sounds good.', 'standard')).toBe('Sounds good.')
    expect(applyCasing('Sounds good.', 'lowercase', 'code')).toBe('Sounds good.')
  })

  it('runs in finish, before the trailing space', () => {
    const out = finish('Sounds good.', {
      category: 'chat',
      dictionary: [],
      trailingSpace: true,
      casing: PROFILES.casual.casing
    })
    expect(out.text).toBe('sounds good ')
    expect(out.stages).toContain('casing')
  })
})

describe('prompt', () => {
  it('the system prompt lets a Layout line add paragraphs', () => {
    const system = buildFormatMessages('x', { category: 'chat', tone: 'casual', dictionary: [] })[0]
    expect(system.content).toContain('unless a "Layout" line asks for one')
  })
})
