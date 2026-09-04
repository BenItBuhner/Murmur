import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { chordLabel } from '@core/hotkey/keys'
import type { Settings } from '@shared/settings'
import { Recorder } from './audio/recorder'
import { applyLaunchAtLogin } from './autostart'
import { DictationController } from './dictation/session'
import { HookService } from './hotkeys/hook'
import { registerIpc } from './ipc'
import { createLogger, initLogger } from './logger'
import { getActiveWindow } from './active-window'
import { HistoryStore } from './store/history'
import { SettingsStore } from './store/settings'
import { AppTray } from './tray'
import {
  createMainWindow,
  getMainWindow,
  setQuitting,
  setShowOnReady,
  showMainWindow,
  updateTitleBar
} from './windows/main-window'
import { OverlayWindow } from './windows/overlay'
import { IPC } from '@shared/ipc'

// Transparent overlay on Linux needs these before `ready`; harmless elsewhere.
app.commandLine.appendSwitch('enable-transparent-visuals')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (process.platform === 'linux' && !process.env.MURMUR_KEEP_GPU) {
  // Compositor-less X sessions (and most VMs) render transparent windows black with the GPU path.
  app.disableHardwareAcceleration()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  await app.whenReady()
  electronApp.setAppUserModelId('app.murmur.dictation')
  const userData = app.getPath('userData')
  const logPath = initLogger(
    `${userData}/logs`,
    process.env.MURMUR_LOG_LEVEL === 'debug' ? 'debug' : 'info'
  )
  const log = createLogger('main')
  log.info(
    `Murmur ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform}/${process.arch})`
  )
  log.info(`logs: ${logPath}`)

  const settings = new SettingsStore(userData)
  const history = new HistoryStore(userData)
  const overlay = new OverlayWindow()
  const recorder = new Recorder(overlay)
  const hook = new HookService(settings.get())
  let tray: AppTray | null = null
  let quitting = false

  const controller = new DictationController({
    settings,
    history,
    recorder,
    hook,
    overlay: { setState: (s) => overlay.setState(s), playSound: (n) => overlay.playSound(n) },
    getActiveWindow
  })

  const resolvedTheme = (s: Settings): 'light' | 'dark' =>
    s.general.theme === 'system'
      ? nativeTheme.shouldUseDarkColors
        ? 'dark'
        : 'light'
      : s.general.theme

  const applySettings = (s: Settings): void => {
    hook.applySettings(s)
    recorder.configure({
      deviceId: s.audio.deviceId,
      keepWarm: s.audio.keepMicWarm,
      preBufferMs: s.audio.preBufferMs,
      noiseSuppression: s.audio.noiseSuppression,
      autoGainControl: s.audio.autoGainControl,
      soundVolume: s.general.sounds ? s.general.soundVolume : 0,
      theme: resolvedTheme(s)
    })
    overlay.configureVisibility(
      s.general.showOverlayWhenIdle && s.onboardingComplete,
      s.general.overlayPosition
    )
    tray?.setHotkeyLabel(chordLabel(s.hotkeys.pushToTalk, hook.platform, s.hotkeys.sideSensitive))
    applyLaunchAtLogin(s.general.launchAtLogin)
    nativeTheme.themeSource = s.general.theme
    updateTitleBar(resolvedTheme(s))
  }

  const quit = (): void => {
    quitting = true
    setQuitting(true)
    app.quit()
  }

  const setEnabled = (enabled: boolean): void => {
    controller.setEnabled(enabled)
    tray?.setEnabled(enabled)
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.enabledChanged, enabled)
  }

  // Linux needs a beat after `ready` before transparent windows compose correctly.
  if (process.platform === 'linux') await new Promise((r) => setTimeout(r, 250))

  overlay.create()
  const s0 = settings.get()
  const hidden = process.argv.includes('--hidden')
  setShowOnReady(!(hidden || (s0.general.startMinimized && s0.onboardingComplete)))
  createMainWindow(resolvedTheme(s0))

  tray = new AppTray({
    toggleDictation: () => controller.toggle(),
    setEnabled,
    openApp: (route) => showMainWindow(route),
    openLogs: () => shell.showItemInFolder(logPath),
    quit
  })

  registerIpc({ settings, history, controller, hook, onEnabledChange: setEnabled, quit })

  hook.on('action', (a) => controller.handle(a))
  hook.start()
  controller.on('state', (phase: 'idle' | 'listening' | 'processing') => tray?.setPhase(phase))
  controller.on('entry', () => undefined)
  settings.on('change', (s: Settings) => applySettings(s))
  applySettings(s0)

  overlay.whenReady().then(() => {
    recorder.resend()
    log.info(`overlay ready; hook=${hook.backend}`)
  })

  // Broadcast dictation state to the settings window for its live indicator.
  const relay = (): void => {
    const state = overlay.getState()
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.dictationState, { state })
  }
  controller.on('state', relay)
  controller.on('entry', relay)

  app.on('second-instance', () => showMainWindow())
  app.on('activate', () => {
    if (!getMainWindow()) createMainWindow(resolvedTheme(settings.get()))
    showMainWindow()
  })
  app.on('browser-window-created', (_e, window) => optimizer.watchWindowShortcuts(window))
  app.on('window-all-closed', () => {
    // Tray app: keep running.
  })
  app.on('before-quit', () => {
    quitting = true
    setQuitting(true)
    hook.stop()
    settings.flush()
    history.flush()
  })
  app.on('will-quit', () => {
    tray?.destroy()
    overlay.destroy()
  })
  void quitting
}
