import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The limit pill's ways forward arrive in the main process as plain `ipcMain.on` messages from the
 * overlay renderer (src/preload/overlay.ts). These tests pin what each one does.
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const openExternal = vi.fn()
const showMainWindow = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal },
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeListener: () => undefined
  }
}))
vi.mock('../src/main/windows/main-window', () => ({
  showMainWindow,
  updateChrome: vi.fn()
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getLogPath: () => '/tmp/murmur.log'
}))
vi.mock('../src/main/inject', () => ({
  injectText: vi.fn(),
  injectionBackendName: () => 'test'
}))
vi.mock('../src/main/inject/linux', () => ({ sessionType: () => 'x11' }))

const { registerIpc } = await import('../src/main/ipc')
const { IPC } = await import('../src/shared/ipc')

function emitter(): EventEmitter & Record<string, unknown> {
  return new EventEmitter() as EventEmitter & Record<string, unknown>
}

describe('the limit pill on the main-process side', () => {
  const overlay = { dismiss: vi.fn(), getState: () => ({ phase: 'idle' }), setState: vi.fn() }
  const controller = { retry: vi.fn(async () => ({ ok: true })) }

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerIpc({
      settings: Object.assign(emitter(), { get: () => ({}), patch: vi.fn() }),
      history: emitter(),
      recordings: {},
      controller,
      overlay,
      hook: emitter(),
      inference: {},
      cloudConfig: { accountMode: 'off' },
      cloud: emitter(),
      updates: emitter(),
      updateSource: { repo: 'x/y', apiBase: 'https://api.github.com' },
      systemAccent: () => null,
      onEnabledChange: vi.fn(),
      quit: vi.fn()
    } as unknown as Parameters<typeof registerIpc>[0])
  })

  it('"Use my own model" brings the Models page up and waves the notice away', () => {
    handlers.get(IPC.overlayOpenModels)!({})
    expect(showMainWindow).toHaveBeenCalledWith('providers')
    expect(overlay.dismiss).toHaveBeenCalledTimes(1)
  })

  it('"Upgrade" opens the account page in the browser, https only', () => {
    handlers.get(IPC.overlayOpenUrl)!({}, 'https://murmur.app/account?upgrade=yearly')
    expect(openExternal).toHaveBeenCalledWith('https://murmur.app/account?upgrade=yearly')
    expect(overlay.dismiss).toHaveBeenCalledTimes(1)
    handlers.get(IPC.overlayOpenUrl)!({}, 'file:///etc/passwd')
    handlers.get(IPC.overlayOpenUrl)!({}, 'javascript:alert(1)')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('"Retry" sends the kept recording again and inserts the result', () => {
    handlers.get(IPC.overlayRetry)!({}, 'entry-1')
    expect(controller.retry).toHaveBeenCalledWith('entry-1', { inject: true })
    handlers.get(IPC.overlayRetry)!({}, 42)
    expect(controller.retry).toHaveBeenCalledTimes(1)
  })

  it('the cross only dismisses', () => {
    handlers.get(IPC.overlayDismiss)!({})
    expect(overlay.dismiss).toHaveBeenCalledTimes(1)
    expect(showMainWindow).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})
