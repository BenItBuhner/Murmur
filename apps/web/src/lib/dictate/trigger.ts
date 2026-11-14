/**
 * The desktop app's default trigger, in the browser: hold Ctrl + Win/Cmd to talk and release to
 * transcribe (push-to-talk), or press Ctrl + Win/Cmd + Space to start hands-free and press it
 * again to stop (desktop settings.ts `hotkeys.pushToTalk` / `hotkeys.handsFree`). A web page only
 * hears keys while it has focus, which the small window makes easy to keep. Space alone, held
 * while the page has focus and no text field is focused, is push-to-talk too, for keyboards
 * where the OS keeps the Win/Cmd key for itself.
 */
export type TriggerEvent = 'hold-start' | 'hold-end' | 'toggle'

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  repeat?: boolean
}

export class Trigger {
  private holding: 'chord' | 'space' | null = null
  private suppressHold = false

  constructor(private readonly emit: (e: TriggerEvent) => void) {}

  /** Returns true when the key was the trigger's (the caller then prevents the default). */
  down(e: KeyLike, typing: boolean): boolean {
    const isCtrl = e.key === 'Control'
    const isMeta = e.key === 'Meta' || e.key === 'OS'
    if (e.code === 'Space' && e.ctrlKey && e.metaKey) {
      if (e.repeat) return true
      // Space on top of a held chord switches that dictation to hands-free.
      if (this.holding === 'chord') this.holding = null
      this.suppressHold = true
      this.emit('toggle')
      return true
    }
    if ((isCtrl && e.metaKey) || (isMeta && e.ctrlKey)) {
      if (!this.holding && !e.repeat && !this.suppressHold) {
        this.holding = 'chord'
        this.emit('hold-start')
      }
      return true
    }
    if (e.code === 'Space' && !typing && !e.ctrlKey && !e.metaKey) {
      if (!this.holding && !e.repeat) {
        this.holding = 'space'
        this.emit('hold-start')
      }
      return true
    }
    return false
  }

  up(e: KeyLike): boolean {
    const chordKey = e.key === 'Control' || e.key === 'Meta' || e.key === 'OS'
    if (chordKey) this.suppressHold = false
    if (this.holding === 'chord' && chordKey) {
      this.holding = null
      this.emit('hold-end')
      return true
    }
    if (this.holding === 'space' && e.code === 'Space') {
      this.holding = null
      this.emit('hold-end')
      return true
    }
    return false
  }

  /** The window lost focus mid-hold: finish the dictation rather than record forever. */
  blur(): void {
    if (this.holding) {
      this.holding = null
      this.emit('hold-end')
    }
    this.suppressHold = false
  }
}
