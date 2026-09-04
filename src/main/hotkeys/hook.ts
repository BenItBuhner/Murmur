import { EventEmitter } from 'node:events'
import { globalShortcut } from 'electron'
import { HotkeyEngine, type HotkeyAction, type HotkeyEngineConfig } from '@core/hotkey/engine'
import {
  Key,
  canonicalChord,
  chordLabel,
  electronAccelerator,
  mouseButtonCode,
  validateChord,
  type KeyPlatform
} from '@core/hotkey/keys'
import type { Settings } from '@shared/settings'
import type { HotkeyCapture } from '@shared/types'
import { createLogger } from '../logger'

const log = createLogger('hook')

export type HookBackend = 'uiohook' | 'globalShortcut' | 'none'

type UiohookModule = typeof import('uiohook-napi')

interface CaptureState {
  down: Set<number>
  combo: number[]
}

/**
 * Bridges OS-level key events to the pure HotkeyEngine.
 *
 * Primary backend is libuiohook (real key down/up, so hold-to-talk works and the chord can be
 * modifier-only like Ctrl+Win). If the hook cannot start (e.g. pure Wayland with no XWayland,
 * or a locked-down session) we degrade to Electron's globalShortcut, which only fires on press,
 * so the chord toggles hands-free sessions instead of holding.
 */
export class HookService extends EventEmitter {
  backend: HookBackend = 'none'
  private engine: HotkeyEngine
  private uiohook: UiohookModule | null = null
  private capture: CaptureState | null = null
  private sideSensitive = false
  private physicallyDown = new Set<number>()
  private registeredAccelerators: string[] = []
  private started = false
  private synthetic = false
  private syntheticTimer: NodeJS.Timeout | null = null

  constructor(private settings: Settings) {
    super()
    this.engine = new HotkeyEngine(HookService.engineConfig(settings))
    this.sideSensitive = settings.hotkeys.sideSensitive
  }

  static engineConfig(s: Settings): HotkeyEngineConfig {
    return {
      pushToTalk: s.hotkeys.pushToTalk,
      handsFree: s.hotkeys.handsFree,
      commandMode: s.hotkeys.commandMode,
      handsFreeTrigger: s.hotkeys.handsFreeTrigger,
      tapThresholdMs: s.hotkeys.tapThresholdMs,
      doubleTapWindowMs: s.hotkeys.doubleTapWindowMs,
      sideSensitive: s.hotkeys.sideSensitive,
      escapeCancels: s.hotkeys.escapeCancels
    }
  }

  get platform(): KeyPlatform {
    return process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux'
  }

  start(): void {
    if (this.started) return
    this.started = true
    try {
      // Lazy require so a missing prebuild degrades gracefully instead of crashing startup.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('uiohook-napi') as UiohookModule
      mod.uIOhook.on('keydown', (e) => this.onKey(e.keycode, true))
      mod.uIOhook.on('keyup', (e) => this.onKey(e.keycode, false))
      mod.uIOhook.on('mousedown', (e) => this.onKey(mouseButtonCode(Number(e.button)), true))
      mod.uIOhook.on('mouseup', (e) => this.onKey(mouseButtonCode(Number(e.button)), false))
      mod.uIOhook.start()
      this.uiohook = mod
      this.backend = 'uiohook'
      log.info('uiohook started')
    } catch (err) {
      log.error('uiohook failed to start; falling back to globalShortcut', err)
      this.backend = 'globalShortcut'
      this.registerGlobalShortcuts()
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    try {
      this.uiohook?.uIOhook.stop()
    } catch (err) {
      log.warn('uiohook stop failed', err)
    }
    this.unregisterGlobalShortcuts()
    this.engine.reset()
    this.physicallyDown.clear()
  }

  applySettings(s: Settings): void {
    this.settings = s
    this.sideSensitive = s.hotkeys.sideSensitive
    this.engine.applyConfig(HookService.engineConfig(s))
    if (this.backend === 'globalShortcut') {
      this.unregisterGlobalShortcuts()
      this.registerGlobalShortcuts()
    }
  }

  /**
   * Murmur is about to synthesize keystrokes (paste, copy-for-selection). Ignore all hook events
   * until `endSynthetic`, otherwise our own Ctrl+C / Ctrl+V feed back into the chord matcher and
   * can spawn phantom sessions.
   */
  beginSynthetic(): void {
    if (this.syntheticTimer) {
      clearTimeout(this.syntheticTimer)
      this.syntheticTimer = null
    }
    this.synthetic = true
  }

  endSynthetic(trailingMs = 160): void {
    if (this.syntheticTimer) clearTimeout(this.syntheticTimer)
    // Trailing delay: synthesized events arrive slightly after the injecting call returns.
    this.syntheticTimer = setTimeout(
      () => {
        this.synthetic = false
        this.syntheticTimer = null
      },
      Math.max(0, trailingMs)
    )
  }

  /** Session bookkeeping the host must relay so the engine's notion of "listening" stays true. */
  notifySessionEnded(): void {
    this.engine.externalStop()
  }

  notifySessionStarted(mode: 'hands-free' | 'command' | 'hold'): void {
    this.engine.externalStart(mode, performance.now())
  }

  get isListening(): boolean {
    return this.engine.isListening
  }

  /** True while any physical key we have seen pressed is still down. */
  get anyKeyDown(): boolean {
    return this.physicallyDown.size > 0
  }

  /** Resolve once the user has released every key, or after `timeoutMs`. Injection waits on this. */
  waitForKeysUp(timeoutMs = 1500): Promise<boolean> {
    if (!this.anyKeyDown) return Promise.resolve(true)
    return new Promise((resolve) => {
      const started = Date.now()
      const check = (): void => {
        if (!this.anyKeyDown) return resolve(true)
        if (Date.now() - started > timeoutMs) return resolve(false)
        setTimeout(check, 15)
      }
      check()
    })
  }

  // ---- capture mode -------------------------------------------------------------------------

  startCapture(): void {
    this.capture = { down: new Set(), combo: [] }
    this.engine.reset()
    this.emit('capture', this.captureSnapshot())
  }

  stopCapture(): void {
    this.capture = null
  }

  labelFor(keys: number[]): string {
    return chordLabel(keys, this.platform, this.sideSensitive)
  }

  private captureSnapshot(final = false): HotkeyCapture {
    const keys = canonicalChord(this.capture?.combo ?? [], this.sideSensitive)
    const v = validateChord(keys, this.sideSensitive)
    return {
      keys,
      label: keys.length ? this.labelFor(keys) : final ? 'Not set' : 'Press keys…',
      valid: v.valid,
      reason: v.reason
    }
  }

  // ---- event plumbing -----------------------------------------------------------------------

  private onKey(code: number, down: boolean): void {
    // Drop events we synthesized ourselves so injection never triggers dictation.
    if (this.synthetic) return
    if (down) this.physicallyDown.add(code)
    else this.physicallyDown.delete(code)

    if (this.capture) {
      if (down) {
        if (code === Key.Escape) {
          this.capture = null
          this.emit('captured', {
            keys: [],
            label: 'Not set',
            valid: false,
            reason: 'Cancelled'
          } satisfies HotkeyCapture)
          return
        }
        this.capture.down.add(code)
        const current = [...this.capture.down]
        if (current.length >= this.capture.combo.length) this.capture.combo = current
        this.emit('capture', this.captureSnapshot())
      } else {
        this.capture.down.delete(code)
        if (this.capture.down.size === 0 && this.capture.combo.length) {
          const snap = this.captureSnapshot(true)
          this.capture = null
          this.emit('captured', snap)
        }
      }
      return
    }

    const now = performance.now()
    const actions = down ? this.engine.keyDown(code, now) : this.engine.keyUp(code, now)
    for (const a of actions) this.emit('action', a)
  }

  // ---- globalShortcut fallback --------------------------------------------------------------

  private registerGlobalShortcuts(): void {
    const s = this.settings
    const entries: Array<[number[], 'ptt' | 'handsFree' | 'command']> = [
      [s.hotkeys.pushToTalk, 'ptt'],
      [s.hotkeys.handsFree, 'handsFree'],
      [s.hotkeys.commandMode, 'command']
    ]
    for (const [keys, which] of entries) {
      const acc = electronAccelerator(keys)
      if (!acc) {
        if (keys.length)
          log.warn(
            `Chord ${this.labelFor(keys)} cannot be registered with globalShortcut (modifier-only)`
          )
        continue
      }
      try {
        const ok = globalShortcut.register(acc, () => this.onGlobalShortcut(which))
        if (ok) this.registeredAccelerators.push(acc)
        else log.warn(`globalShortcut refused ${acc}`)
      } catch (err) {
        log.warn(`globalShortcut register failed for ${acc}`, err)
      }
    }
    log.info(
      `globalShortcut fallback registered: ${this.registeredAccelerators.join(', ') || 'nothing'}`
    )
  }

  private unregisterGlobalShortcuts(): void {
    for (const acc of this.registeredAccelerators) {
      try {
        globalShortcut.unregister(acc)
      } catch {
        // ignore
      }
    }
    this.registeredAccelerators = []
  }

  private onGlobalShortcut(which: 'ptt' | 'handsFree' | 'command'): void {
    if (this.capture) return
    if (this.engine.isListening) {
      this.engine.externalStop()
      this.emit('action', { type: 'stop' } satisfies HotkeyAction)
      return
    }
    const mode = which === 'command' ? 'command' : 'hands-free'
    this.engine.externalStart(mode, performance.now())
    this.emit('action', { type: 'start', mode } satisfies HotkeyAction)
  }
}
