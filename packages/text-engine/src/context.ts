import type { AppCategory, FormattingMode, ResolvedTone, Tone } from './types'

export interface AppContext {
  app: string
  title: string
  category: AppCategory
}

const CATEGORY_PATTERNS: Array<[AppCategory, RegExp]> = [
  [
    'chat',
    /slack|discord|teams|telegram|whatsapp|signal|messages|messenger|imessage|zulip|mattermost|element/i
  ],
  ['email', /outlook|thunderbird|mail|gmail|superhuman|spark|hey\.com|proton/i],
  [
    'code',
    /code|cursor|visual studio|jetbrains|intellij|pycharm|webstorm|rider|clion|goland|sublime|vim|neovim|emacs|zed|atom|xcode|android studio/i
  ],
  [
    'terminal',
    /terminal|powershell|cmd\.exe|windows terminal|wezterm|alacritty|kitty|konsole|gnome-terminal|hyper|iterm|warp/i
  ],
  ['notes', /notion|obsidian|onenote|evernote|bear|apple notes|logseq|joplin|roam/i],
  [
    'document',
    /word|winword|docs|libreoffice|pages|writer|scrivener|typora|google docs|confluence/i
  ],
  ['browser', /chrome|firefox|edge|msedge|brave|arc|safari|opera|vivaldi|zen/i]
]

export function classifyApp(app: string, title = ''): AppContext {
  const hay = `${app} ${title}`
  for (const [category, re] of CATEGORY_PATTERNS) {
    if (re.test(hay)) {
      // Browser tabs often reveal the real destination.
      if (category === 'browser') {
        if (/gmail|outlook|mail/i.test(title)) return { app, title, category: 'email' }
        if (/slack|discord|teams|whatsapp|messenger/i.test(title))
          return { app, title, category: 'chat' }
        if (/docs|notion|confluence/i.test(title)) return { app, title, category: 'document' }
      }
      return { app, title, category }
    }
  }
  return { app, title, category: 'unknown' }
}

export function autoTone(category: AppCategory): ResolvedTone {
  switch (category) {
    case 'chat':
      return 'casual'
    case 'email':
    case 'document':
      return 'professional'
    default:
      return 'neutral'
  }
}

export const isTechnical = (category: AppCategory): boolean =>
  category === 'code' || category === 'terminal'

/** The user's global style preferences; everything else is derived from the destination. */
export interface StylePrefs {
  mode: FormattingMode
  tone: Tone
  /** Free-form guidance for the model ("British spelling", "dates as ISO"). */
  instructions: string
  trailingSpace: boolean
}

/** A per-app override; every field but `match` optional so a rule only carries what the user set. */
export interface StyleRule {
  match: string
  tone?: Tone
  mode?: FormattingMode
  trailingSpace?: boolean
  instructions?: string
}

/** Everything the text stages need to know about the destination, already merged. */
export interface ResolvedStyle {
  tone: ResolvedTone
  rule?: StyleRule
  mode: FormattingMode
  instructions: string
  trailingSpace: boolean
}

export function findRule<R extends StyleRule>(rules: readonly R[], ctx: AppContext): R | undefined {
  const hay = `${ctx.app} ${ctx.title}`.toLowerCase()
  return rules.find((r) => r.match.trim() && hay.includes(r.match.trim().toLowerCase()))
}

/** Precedence: the matching per-app rule, then the global settings, then the destination's defaults. */
export function resolveStyle(
  prefs: StylePrefs,
  rules: readonly StyleRule[],
  ctx: AppContext
): ResolvedStyle {
  const rule = findRule(rules, ctx)
  const tone =
    rule?.tone && rule.tone !== 'auto'
      ? rule.tone
      : prefs.tone !== 'auto'
        ? prefs.tone
        : autoTone(ctx.category)
  const instructions = [prefs.instructions.trim(), rule?.instructions?.trim() ?? '']
    .filter(Boolean)
    .join('\n\n')
  return {
    tone,
    rule,
    mode: rule?.mode ?? prefs.mode,
    instructions,
    trailingSpace: rule?.trailingSpace ?? prefs.trailingSpace
  }
}

export function toneDescription(tone: ResolvedTone): string {
  switch (tone) {
    case 'casual':
      return 'casual'
    case 'professional':
      return 'professional'
    default:
      return 'neutral'
  }
}

export function categoryHint(category: AppCategory): string {
  switch (category) {
    case 'chat':
      return 'a chat message'
    case 'email':
      return 'an email'
    case 'code':
      return 'a code editor'
    case 'terminal':
      return 'a terminal'
    case 'document':
      return 'a document'
    case 'notes':
      return 'a notes app'
    case 'browser':
      return 'a web page form field'
    default:
      return 'a text field'
  }
}
