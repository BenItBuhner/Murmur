import type {
  AppRule,
  FormattingMode,
  ListsMode,
  LlmFreedom,
  LlmStructure,
  NumbersMode,
  Settings,
  Tone
} from '@shared/settings'

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

/** Everything the text stages need to know about the destination, already merged. */
export interface ResolvedStyle {
  tone: Exclude<Tone, 'auto'>
  rule?: AppRule
  mode: FormattingMode
  lists: ListsMode
  numbers: NumbersMode
  freedom: LlmFreedom
  structure: LlmStructure
  /** Global instructions followed by the matching rule's, blank line separated. */
  instructions: string
  trailingSpace: boolean
}

export function findRule(rules: readonly AppRule[], ctx: AppContext): AppRule | undefined {
  const hay = `${ctx.app} ${ctx.title}`.toLowerCase()
  return rules.find((r) => r.match.trim() && hay.includes(r.match.trim().toLowerCase()))
}

/**
 * Precedence: a matching per-app rule, then what the destination category demands (code and
 * terminals never get lists and always get digits), then the global settings.
 */
export function resolveStyle(formatting: Settings['formatting'], ctx: AppContext): ResolvedStyle {
  const rule = findRule(formatting.appRules, ctx)
  const tone =
    rule?.tone && rule.tone !== 'auto'
      ? rule.tone
      : formatting.tone !== 'auto'
        ? formatting.tone
        : autoTone(ctx.category)
  const technical = ctx.category === 'code' || ctx.category === 'terminal'
  const instructions = [formatting.llm.instructions.trim(), rule?.instructions?.trim() ?? '']
    .filter(Boolean)
    .join('\n\n')
  return {
    tone,
    rule,
    mode: rule?.formatting ?? formatting.mode,
    lists: rule?.lists ?? (technical ? 'off' : formatting.lists),
    numbers: rule?.numbers ?? (technical ? 'all' : formatting.numbers),
    freedom: rule?.freedom ?? (technical ? 'strict' : formatting.llm.freedom),
    structure: technical ? 'keep' : formatting.llm.structure,
    instructions,
    trailingSpace: rule?.trailingSpace ?? formatting.trailingSpace
  }
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
