import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  globalShortcut: { register: () => true, unregister: () => undefined }
}))

import { HookService } from '../src/main/hotkeys/hook'
import { defaultSettings } from '../src/shared/settings'

type Internals = { onKey: (code: number, down: boolean) => void }

const make = (held: (code: number) => boolean | null = () => null): HookService & Internals =>
  new HookService(defaultSettings(), held) as unknown as HookService & Internals

describe('hook: keys counted as held', () => {
  it('a release during our own keystrokes still counts (Oct 31 2026: 3 s per insertion)', async () => {
    const hook = make()
    hook.onKey(42, true) // Shift down before the paste
    hook.beginSynthetic()
    hook.onKey(42, false) // released while we were pasting
    hook.endSynthetic(0)
    expect(hook.anyKeyDown).toBe(false)
    const started = Date.now()
    expect(await hook.waitForKeysUp(1500)).toBe(true)
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('a key pressed while we inject is not counted (it may be our own Ctrl+V)', () => {
    const hook = make()
    hook.beginSynthetic()
    hook.onKey(29, true)
    expect(hook.anyKeyDown).toBe(false)
  })

  it('a key the OS says is up is dropped although its release was never seen', async () => {
    const down = new Set<number>()
    const hook = make((code) => down.has(code))
    down.add(3675)
    hook.onKey(3675, true)
    expect(hook.anyKeyDown).toBe(true)
    down.delete(3675) // released over an elevated window: no key-up reached the hook
    expect(await hook.waitForKeysUp(1500)).toBe(true)
    expect(hook.heldKeys).toEqual([])
  })

  it('without an OS answer the hook trusts its own events', () => {
    const hook = make(() => null)
    hook.onKey(57, true)
    expect(hook.anyKeyDown).toBe(true)
    hook.onKey(57, false)
    expect(hook.anyKeyDown).toBe(false)
  })
})
