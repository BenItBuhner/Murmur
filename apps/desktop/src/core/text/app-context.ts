import type { AppRule, Tone } from '@shared/settings'

export type AppCategory =
  'chat' | 'email' | 'document' | 'code' | 'terminal' | 'browser' | 'notes' | 'unknown'

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

export function autoTone(category: AppCategory): Exclude<Tone, 'auto'> {
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

export interface ResolvedStyle {
  tone: Exclude<Tone, 'auto'>
  rule?: AppRule
}

export function resolveStyle(
  globalTone: Tone,
  rules: readonly AppRule[],
  ctx: AppContext
): ResolvedStyle {
  const hay = `${ctx.app} ${ctx.title}`.toLowerCase()
  const rule = rules.find((r) => r.match && hay.includes(r.match.toLowerCase()))
  const tone =
    rule?.tone && rule.tone !== 'auto'
      ? rule.tone
      : globalTone !== 'auto'
        ? globalTone
        : autoTone(ctx.category)
  return { tone, rule }
}

export function toneDescription(tone: Exclude<Tone, 'auto'>): string {
  switch (tone) {
    case 'casual':
      return 'Casual and friendly: contractions are fine, keep it light, sentence fragments are acceptable in chat.'
    case 'professional':
      return 'Professional and polished: complete sentences, correct grammar, no slang.'
    default:
      return 'Neutral and clear: natural sentences, faithful to how the speaker talks.'
  }
}

export function categoryHint(category: AppCategory): string {
  switch (category) {
    case 'chat':
      return 'a chat message'
    case 'email':
      return 'an email'
    case 'code':
      return 'a code editor (preserve identifiers, file names, and technical terms exactly; do not add prose punctuation to code)'
    case 'terminal':
      return 'a terminal (likely a command; keep it on one line and do not add trailing punctuation)'
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
