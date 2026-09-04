import { Key, canonicalChord, canonicalKey } from './keys'
import type { DictationMode } from '@shared/types'

export type HotkeyAction =
  { type: 'start'; mode: DictationMode } | { type: 'lock' } | { type: 'stop' } | { type: 'cancel' }

export interface HotkeyEngineConfig {
  pushToTalk: number[]
  handsFree: number[]
  commandMode: number[]
  handsFreeTrigger: 'tap' | 'double-tap' | 'off'
  tapThresholdMs: number
  doubleTapWindowMs: number
  sideSensitive: boolean
  escapeCancels: boolean
}

type ChordId = 'ptt' | 'handsFree' | 'command'

interface Session {
  mode: DictationMode
  chord: ChordId
  startedAt: number
  locked: boolean
}

export class HotkeyEngine {
  private down = new Set<number>()
  private session: Session | null = null
  private lastTapAt: number | null = null
  private chords: Record<ChordId, number[]> = { ptt: [], handsFree: [], command: [] }

  constructor(private config: HotkeyEngineConfig) { this.applyConfig(config) }

  applyConfig(config: HotkeyEngineConfig): void {
    this.config = config
    const c = (keys: number[]): number[] => canonicalChord(keys, config.sideSensitive)
    this.chords = { ptt: c(config.pushToTalk), handsFree: c(config.handsFree), command: c(config.commandMode) }
  }

  reset(): void { this.down.clear(); this.session = null; this.lastTapAt = null }
  get isListening(): boolean { return this.session !== null }
  get isLocked(): boolean { return this.session?.locked ?? false }
  get currentMode(): DictationMode | null { return this.session?.mode ?? null }
  externalStop(): void { this.session = null }
  externalStart(mode: DictationMode, now: number): void { this.session = { mode, chord: 'handsFree', startedAt: now, locked: true } }

  keyDown(rawCode: number, now: number): HotkeyAction[] {
    const code = canonicalKey(rawCode, this.config.sideSensitive)
    if (this.down.has(code)) return []
    this.down.add(code)
    if (code === Key.Escape) {
      if (this.session && this.config.escapeCancels) { this.session = null; return [{ type: 'cancel' }] }
      return []
    }
    const activated = this.newlyActiveChords(code)
    if (!activated.length) return []
    const chord = activated[0]
    if (this.session) {
      if (this.session.locked) { this.session = null; return [{ type: 'stop' }] }
      if (chord === 'handsFree' && this.session.mode !== 'command') { this.session.locked = true; this.session.chord = 'handsFree'; return [{ type: 'lock' }] }
      return []
    }
    if (chord === 'handsFree') { this.session = { mode: 'hands-free', chord, startedAt: now, locked: true }; return [{ type: 'start', mode: 'hands-free' }] }
    if (chord === 'command') { this.session = { mode: 'command', chord, startedAt: now, locked: false }; return [{ type: 'start', mode: 'command' }] }
    const isDoubleTap = this.config.handsFreeTrigger === 'double-tap' && this.lastTapAt !== null && now - this.lastTapAt <= this.config.doubleTapWindowMs
    this.lastTapAt = null
    if (isDoubleTap) { this.session = { mode: 'hands-free', chord, startedAt: now, locked: true }; return [{ type: 'start', mode: 'hands-free' }] }
    this.session = { mode: 'hold', chord, startedAt: now, locked: false }
    return [{ type: 'start', mode: 'hold' }]
  }

  keyUp(rawCode: number, now: number): HotkeyAction[] {
    const code = canonicalKey(rawCode, this.config.sideSensitive)
    if (!this.down.delete(code)) return []
    const session = this.session
    if (!session || session.locked) return []
    if (!this.chords[session.chord].includes(code)) return []
    const held = now - session.startedAt
    if (held < this.config.tapThresholdMs && session.mode !== 'command') {
      switch (this.config.handsFreeTrigger) {
        case 'tap': session.locked = true; return [{ type: 'lock' }]
        case 'double-tap': this.lastTapAt = now; this.session = null; return [{ type: 'stop' }]
        case 'off': break
      }
    }
    this.session = null
    return [{ type: 'stop' }]
  }

  private newlyActiveChords(code: number): ChordId[] {
    const ids: ChordId[] = ['handsFree', 'command', 'ptt']
    return ids.filter((id) => { const keys = this.chords[id]; return keys.length > 0 && keys.includes(code) && keys.every((k) => this.down.has(k)) }).sort((a, b) => this.chords[b].length - this.chords[a].length)
  }

  snapshot(): { down: number[]; session: Session | null; lastTapAt: number | null } {
    return { down: [...this.down], session: this.session ? { ...this.session } : null, lastTapAt: this.lastTapAt }
  }
}
