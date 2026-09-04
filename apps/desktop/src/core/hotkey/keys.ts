/**
 * Key identity for hotkeys. We store libuiohook keycodes (stable across
 * Windows/Linux/macOS) plus a synthetic range for mouse buttons.
 */

export const MOUSE_BUTTON_BASE = 20000
export const mouseButtonCode = (button: number): number => MOUSE_BUTTON_BASE + button
export const isMouseButtonCode = (code: number): boolean =>
  code >= MOUSE_BUTTON_BASE && code < MOUSE_BUTTON_BASE + 64

export const Key = {
  Escape: 1,
  Backspace: 14,
  Tab: 15,
  Enter: 28,
  Ctrl: 29,
  CtrlRight: 3613,
  Shift: 42,
  ShiftRight: 54,
  Alt: 56,
  AltRight: 3640,
  Space: 57,
  CapsLock: 58,
  Meta: 3675,
  MetaRight: 3676,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  F11: 87,
  F12: 88,
  F13: 91,
  F14: 92,
  F15: 93,
  F16: 99,
  F17: 100,
  F18: 101,
  F19: 102,
  F20: 103,
  F21: 104,
  F22: 105,
  F23: 106,
  F24: 107,
  Insert: 3666,
  Delete: 3667,
  Home: 3655,
  End: 3663,
  PageUp: 3657,
  PageDown: 3665,
  ArrowLeft: 57419,
  ArrowUp: 57416,
  ArrowRight: 57421,
  ArrowDown: 57424,
  PrintScreen: 3639,
  ScrollLock: 70,
  NumLock: 69,
  Backquote: 41,
  Minus: 12,
  Equal: 13,
  BracketLeft: 26,
  BracketRight: 27,
  Backslash: 43,
  Semicolon: 39,
  Quote: 40,
  Comma: 51,
  Period: 52,
  Slash: 53,
  V: 47,
  C: 46,
  A: 30,
  Z: 44,
  X: 45
} as const

const LETTERS: Record<number, string> = {
  30: 'A',
  48: 'B',
  46: 'C',
  32: 'D',
  18: 'E',
  33: 'F',
  34: 'G',
  35: 'H',
  23: 'I',
  36: 'J',
  37: 'K',
  38: 'L',
  50: 'M',
  49: 'N',
  24: 'O',
  25: 'P',
  16: 'Q',
  19: 'R',
  31: 'S',
  20: 'T',
  22: 'U',
  47: 'V',
  17: 'W',
  45: 'X',
  21: 'Y',
  44: 'Z'
}
const DIGITS: Record<number, string> = {
  11: '0',
  2: '1',
  3: '2',
  4: '3',
  5: '4',
  6: '5',
  7: '6',
  8: '7',
  9: '8',
  10: '9'
}
const NUMPAD: Record<number, string> = {
  82: 'Num0',
  79: 'Num1',
  80: 'Num2',
  81: 'Num3',
  75: 'Num4',
  76: 'Num5',
  77: 'Num6',
  71: 'Num7',
  72: 'Num8',
  73: 'Num9',
  55: 'Num*',
  78: 'Num+',
  74: 'Num-',
  83: 'Num.',
  3637: 'Num/'
}
const PUNCT: Record<number, string> = {
  41: '`',
  12: '-',
  13: '=',
  26: '[',
  27: ']',
  43: '\\',
  39: ';',
  40: "'",
  51: ',',
  52: '.',
  53: '/'
}

export const MODIFIER_CODES = new Set<number>([
  Key.Ctrl,
  Key.CtrlRight,
  Key.Shift,
  Key.ShiftRight,
  Key.Alt,
  Key.AltRight,
  Key.Meta,
  Key.MetaRight
])

const RIGHT_TO_LEFT: Record<number, number> = {
  [Key.CtrlRight]: Key.Ctrl,
  [Key.ShiftRight]: Key.Shift,
  [Key.AltRight]: Key.Alt,
  [Key.MetaRight]: Key.Meta
}
const LEFT_TO_RIGHT: Record<number, number> = Object.fromEntries(
  Object.entries(RIGHT_TO_LEFT).map(([r, l]) => [l, Number(r)])
)

export const isModifier = (code: number): boolean => MODIFIER_CODES.has(code)
export const isFunctionKey = (code: number): boolean =>
  (code >= 59 && code <= 68) ||
  (code >= 87 && code <= 88) ||
  (code >= 91 && code <= 93) ||
  (code >= 99 && code <= 107)

/** Collapse right-hand modifiers onto their left-hand code. */
export function canonicalKey(code: number, sideSensitive = false): number {
  if (sideSensitive) return code
  return RIGHT_TO_LEFT[code] ?? code
}

export function canonicalChord(keys: readonly number[], sideSensitive = false): number[] {
  const out = new Set<number>()
  for (const k of keys) out.add(canonicalKey(k, sideSensitive))
  return [...out].sort((a, b) => modifierRank(a) - modifierRank(b) || a - b)
}

function modifierRank(code: number): number {
  const base = canonicalKey(code)
  switch (base) {
    case Key.Ctrl:
      return 0
    case Key.Alt:
      return 1
    case Key.Shift:
      return 2
    case Key.Meta:
      return 3
    default:
      return 10
  }
}

export type KeyPlatform = 'win32' | 'linux' | 'darwin'

export function keyName(code: number, platform: KeyPlatform = 'win32'): string {
  if (isMouseButtonCode(code)) {
    const b = code - MOUSE_BUTTON_BASE
    if (b === 3) return 'Middle Click'
    return `Mouse ${b}`
  }
  const meta = platform === 'darwin' ? 'Cmd' : platform === 'linux' ? 'Super' : 'Win'
  const alt = platform === 'darwin' ? 'Option' : 'Alt'
  switch (code) {
    case Key.Ctrl:
      return 'Ctrl'
    case Key.CtrlRight:
      return 'Right Ctrl'
    case Key.Shift:
      return 'Shift'
    case Key.ShiftRight:
      return 'Right Shift'
    case Key.Alt:
      return alt
    case Key.AltRight:
      return `Right ${alt}`
    case Key.Meta:
      return meta
    case Key.MetaRight:
      return `Right ${meta}`
    case Key.Space:
      return 'Space'
    case Key.Escape:
      return 'Esc'
    case Key.Enter:
      return 'Enter'
    case Key.Tab:
      return 'Tab'
    case Key.Backspace:
      return 'Backspace'
    case Key.CapsLock:
      return 'Caps Lock'
    case Key.Insert:
      return 'Insert'
    case Key.Delete:
      return 'Delete'
    case Key.Home:
      return 'Home'
    case Key.End:
      return 'End'
    case Key.PageUp:
      return 'Page Up'
    case Key.PageDown:
      return 'Page Down'
    case Key.ArrowLeft:
      return '←'
    case Key.ArrowRight:
      return '→'
    case Key.ArrowUp:
      return '↑'
    case Key.ArrowDown:
      return '↓'
    case Key.PrintScreen:
      return 'Print Screen'
    case Key.ScrollLock:
      return 'Scroll Lock'
    case Key.NumLock:
      return 'Num Lock'
  }
  if (isFunctionKey(code)) return functionKeyName(code)
  if (LETTERS[code]) return LETTERS[code]
  if (DIGITS[code]) return DIGITS[code]
  if (NUMPAD[code]) return NUMPAD[code]
  if (PUNCT[code]) return PUNCT[code]
  return `Key ${code}`
}

function functionKeyName(code: number): string {
  if (code >= 59 && code <= 68) return `F${code - 58}`
  if (code === 87) return 'F11'
  if (code === 88) return 'F12'
  if (code >= 91 && code <= 93) return `F${code - 78}`
  if (code >= 99 && code <= 107) return `F${code - 83}`
  return `F?`
}

export function chordLabel(
  keys: readonly number[],
  platform: KeyPlatform = 'win32',
  sideSensitive = false
): string {
  if (!keys.length) return 'Not set'
  return canonicalChord(keys, sideSensitive)
    .map((k) => keyName(k, platform))
    .join(' + ')
}

/** Electron accelerator name for the globalShortcut fallback. Returns null if not expressible. */
export function electronAccelerator(keys: readonly number[]): string | null {
  const parts: string[] = []
  for (const code of canonicalChord(keys)) {
    if (isMouseButtonCode(code)) return null
    switch (code) {
      case Key.Ctrl:
        parts.push('CommandOrControl')
        continue
      case Key.Alt:
        parts.push('Alt')
        continue
      case Key.Shift:
        parts.push('Shift')
        continue
      case Key.Meta:
        parts.push('Super')
        continue
      case Key.Space:
        parts.push('Space')
        continue
      case Key.Escape:
        parts.push('Escape')
        continue
      case Key.Enter:
        parts.push('Return')
        continue
      case Key.Tab:
        parts.push('Tab')
        continue
      case Key.Backspace:
        parts.push('Backspace')
        continue
      case Key.Insert:
        parts.push('Insert')
        continue
      case Key.Delete:
        parts.push('Delete')
        continue
      case Key.Home:
        parts.push('Home')
        continue
      case Key.End:
        parts.push('End')
        continue
      case Key.PageUp:
        parts.push('PageUp')
        continue
      case Key.PageDown:
        parts.push('PageDown')
        continue
      case Key.ArrowLeft:
        parts.push('Left')
        continue
      case Key.ArrowRight:
        parts.push('Right')
        continue
      case Key.ArrowUp:
        parts.push('Up')
        continue
      case Key.ArrowDown:
        parts.push('Down')
        continue
    }
    if (isFunctionKey(code)) {
      parts.push(functionKeyName(code))
      continue
    }
    if (LETTERS[code]) {
      parts.push(LETTERS[code])
      continue
    }
    if (DIGITS[code]) {
      parts.push(DIGITS[code])
      continue
    }
    return null
  }
  // Electron cannot register modifier-only accelerators.
  if (parts.every((p) => ['CommandOrControl', 'Alt', 'Shift', 'Super'].includes(p))) return null
  return parts.join('+')
}

export interface ChordValidation {
  valid: boolean
  reason?: string
}

const BLOCKED_COMBOS: number[][] = [
  [Key.Ctrl, Key.A],
  [Key.Ctrl, Key.C],
  [Key.Ctrl, Key.V],
  [Key.Ctrl, Key.X],
  [Key.Ctrl, Key.Z],
  [Key.Ctrl, Key.Shift, 19], // Ctrl+Shift+R
  [Key.Ctrl, Key.F5],
  [Key.Alt, Key.F4],
  [Key.Ctrl, Key.Alt, Key.Delete],
  [Key.Alt, Key.Tab],
  [Key.Meta, 38] // Win+L
]

/**
 * Mirrors the product rules users already know from Wispr Flow: a shortcut must
 * include a modifier (or be a function key / mouse button), have at most three
 * keys, not mix left/right variants of the same modifier, and avoid OS combos.
 */
export function validateChord(keys: readonly number[], sideSensitive = false): ChordValidation {
  if (!keys.length) return { valid: false, reason: 'Press at least one key.' }
  if (keys.length > 3) return { valid: false, reason: 'Shortcut must contain 3 or fewer keys.' }
  if (keys.some((k) => k === Key.Escape))
    return { valid: false, reason: 'Esc is reserved for cancelling dictation.' }
  if (keys.some((k) => isMouseButtonCode(k) && k - MOUSE_BUTTON_BASE <= 2)) {
    return { valid: false, reason: 'Left and right click cannot be used.' }
  }
  for (const [l, r] of Object.entries(LEFT_TO_RIGHT)) {
    if (keys.includes(Number(l)) && keys.includes(r)) {
      return {
        valid: false,
        reason: 'Shortcut cannot contain both left and right versions of the same key.'
      }
    }
  }
  const canon = canonicalChord(keys, sideSensitive)
  const hasModifier = canon.some((k) => isModifier(k))
  const standaloneOk =
    canon.length === 1 &&
    (isFunctionKey(canon[0]) || isMouseButtonCode(canon[0]) || canon[0] === Key.CapsLock)
  if (!hasModifier && !standaloneOk) {
    return {
      valid: false,
      reason: 'Include a modifier key (Ctrl, Alt, Shift, Win) or use a function key.'
    }
  }
  const canonSet = new Set(canonicalChord(keys))
  for (const combo of BLOCKED_COMBOS) {
    if (combo.length === canonSet.size && combo.every((k) => canonSet.has(k))) {
      return { valid: false, reason: `${chordLabel(combo)} is reserved by the operating system.` }
    }
  }
  return { valid: true }
}

export function chordsEqual(
  a: readonly number[],
  b: readonly number[],
  sideSensitive = false
): boolean {
  const ca = canonicalChord(a, sideSensitive)
  const cb = canonicalChord(b, sideSensitive)
  return ca.length === cb.length && ca.every((k, i) => k === cb[i])
}

export function chordIsSubset(
  sub: readonly number[],
  sup: readonly number[],
  sideSensitive = false
): boolean {
  const s = new Set(canonicalChord(sup, sideSensitive))
  return canonicalChord(sub, sideSensitive).every((k) => s.has(k))
}
