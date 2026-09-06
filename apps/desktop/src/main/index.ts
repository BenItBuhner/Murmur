import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, protocol, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type { ClerkBridge } from '@clerk/electron'
import { chordLabel } from '@core/hotkey/keys'
import type { Settings } from '@shared/settings'
import { Recorder } from './audio/recorder'
import { applyLaunchAtLogin } from './autostart'
import { buildTimeCloudConfig, resolveCloudConfig } from './cloud/config'
import {
  createClerk,
  installDevCsp,
  registerDeepLinkHandler,
  rendererOrigin,
  RENDERER_HOST,
  serveRenderer
} from './cloud/clerk'
import { buildRendererCsp } from './cloud/csp'
import { CloudSync } from './cloud/sync-engine'
import { TokenBridge } from './cloud/token-bridge'
import { DictationController } from './dictation/session'
import { HookService } from './hotkeys/hook'
import { registerIpc } from './ipc'
import { createLogger, initLogger } from './logger'
import { getActiveWindow } from './active-window'
import { HistoryStore } from './store/history'
import { SettingsStore } from './store/settings'
import { AppTray } from './tray'
import { SystemAccent } from './theme/system-accent'
import {
  createMainWindow,
  defaultChrome,
  getMainWindow,
  setQuitting,
  setRendererOrigin,
  setShowOnReady,
  showMainWindow
} from './windows/main-window'
import { OverlayWindow } from './windows/overlay'
import { IPC, type ThemeMessage } from '@shared/ipc'

// Transparent overlay on Linux needs these before `ready`; harmless elsewhere.
app.commandLine.appendSwitch('enable-transparent-visuals')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (process.platform === 'linux' && !process.env.MURMUR_KEEP_GPU) {
  // Compositor-less X sessions (and most VMs) render transparent windows black with the GPU path.
  app.disableHardwareAcceleration()
}

// Cloud/account configuration is decided before `ready`: the Clerk bridge must register the
// privileged `murmur://` scheme the packaged renderer is served from before the app is ready.
const cloud = resolveCloudConfig(process.env, buildTimeCloudConfig())
const cloudConfig = cloud.config
const userDataPath = app.getPath('userData')
let clerk: ClerkBridge | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  if (cloudConfig.accountMode !== 'off') {
    clerk = createClerk(cloudConfig, userDataPath)
  } else {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: cloudConfig.deepLinkScheme,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true
        }
      }
    ])
  }
  void main()
}

async function main(): Promise<void> {
  await app.whenReady()
  electronApp.setAppUserModelId('app.murmur.dictation')
  const userData = userDataPath
  const logPath = initLogger(
    `${userData}/logs`,
    process.env.MURMUR_LOG_LEVEL === 'debug' ? 'debug' : 'info'
  )
  const log = createLogger('main')
  log.info(
    `Murmur ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform}/${process.arch})`
  )
  log.info(`logs: ${logPath}`)
  for (const warning of cloud.warnings) log.warn(warning)
  log.info(
    cloudConfig.accountMode === 'off'
      ? 'accounts: off (local mode)'
      : `accounts: ${cloudConfig.accountMode} (convex ${cloudConfig.convexUrl}, clerk ${cloudConfig.clerkFrontendApiHost})`
  )

  // The settings window is served from a stable origin in packaged builds (Clerk requires one; it
  // also gives the renderer a real Content-Security-Policy). Dev builds keep using Vite's server.
  const devServer = is.dev && !!process.env['ELECTRON_RENDERER_URL']
  const csp = buildRendererCsp({
    clerkFrontendApiHost: cloudConfig.clerkFrontendApiHost || undefined,
    dev: devServer
  })
  serveRenderer(cloudConfig.deepLinkScheme, join(__dirname, '../renderer'), csp)
  setRendererOrigin(rendererOrigin(cloudConfig.deepLinkScheme))
  if (devServer) installDevCsp(csp, process.env['ELECTRON_RENDERER_URL']!)
  if (cloudConfig.accountMode !== 'off') registerDeepLinkHandler(cloudConfig.deepLinkScheme)

  const settings = new SettingsStore(userData)
  const history = new HistoryStore(userData)
  const overlay = new OverlayWindow()
  const recorder = new Recorder(overlay)
  const hook = new HookService(settings.get())
  const tokenBridge = new TokenBridge(() => getMainWindow()?.webContents ?? null)
  const cloudSync = new CloudSync({
    config: cloudConfig,
    settings,
    history,
    tokenBridge,
    userDataPath: userData,
    appVersion: app.getVersion(),
    platform: process.platform
  })
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

  // The OS accent colour, for the "System" accent choice. Both renderers build the palette
  // themselves from this message (shared/theme.ts), so main never has to know about CSS.
  const systemAccent = new SystemAccent()
  const themeMessage = (s: Settings): ThemeMessage => ({
    mode: resolvedTheme(s),
    accent: s.general.accent,
    accentColor: s.general.accentColor,
    tintedSurfaces: s.general.tintedSurfaces,
    systemAccent: systemAccent.get()
  })
  const pushTheme = (): void => {
    const msg = themeMessage(settings.get())
    void overlay.whenReady().then(() => overlay.send(IPC.overlayTheme, msg))
  }

  const applySettings = (s: Settings): void => {
    hook.applySettings(s)
    recorder.configure({
      deviceId: s.audio.deviceId,
      keepWarm: s.audio.keepMicWarm,
      preBufferMs: s.audio.preBufferMs,
      noiseSuppression: s.audio.noiseSuppression,
      autoGainControl: s.audio.autoGainControl,
      soundVolume: s.general.sounds ? s.general.soundVolume : 0
    })
    overlay.configureVisibility(
      s.general.showOverlayWhenIdle && s.onboardingComplete,
      s.general.overlayPosition
    )
    tray?.setHotkeyLabel(chordLabel(s.hotkeys.pushToTalk, hook.platform, s.hotkeys.sideSensitive))
    applyLaunchAtLogin(s.general.launchAtLogin)
    nativeTheme.themeSource = s.general.theme
    pushTheme()
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
  // Follow the OS setting from the very first paint so a system-themed window never flashes.
  nativeTheme.themeSource = s0.general.theme
  await systemAccent.start()
  const hidden = process.argv.includes('--hidden')
  setShowOnReady(!(hidden || (s0.general.startMinimized && s0.onboardingComplete)))
  createMainWindow(defaultChrome(resolvedTheme(s0)))

  tray = new AppTray({
    toggleDictation: () => controller.toggle(),
    setEnabled,
    openApp: (route) => showMainWindow(route),
    openLogs: () => shell.showItemInFolder(logPath),
    quit
  })

  registerIpc({
    settings,
    history,
    controller,
    hook,
    cloudConfig,
    cloud: cloudSync,
    systemAccent: () => systemAccent.get(),
    onEnabledChange: setEnabled,
    quit
  })
  cloudSync.start()

  hook.on('action', (a) => controller.handle(a))
  hook.start()
  controller.on('state', (phase: 'idle' | 'listening' | 'processing') => tray?.setPhase(phase))
  controller.on('entry', (entry) => cloudSync.recordSession(entry))
  settings.on('change', (s: Settings) => applySettings(s))
  applySettings(s0)

  // Light/dark flips of the OS ("System" theme) and accent changes reach both renderers.
  nativeTheme.on('updated', pushTheme)
  systemAccent.on('change', (hex: string | null) => {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send(IPC.themeSystemAccentChanged, hex)
    pushTheme()
  })

  overlay.whenReady().then(() => {
    recorder.resend()
    pushTheme()
    log.info(`overlay ready; hook=${hook.backend}`)
  })

  // Broadcast dictation state to the settings window for its live indicator.
  const relay = (): void => {
    const state = overlay.getState()
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.dictationState, { state })
  }
  controller.on('state', relay)
  controller.on('entry', relay)

  app.on('second-instance', (_e, argv) => {
    // OAuth deep links (murmur://app/sso-callback?...) arrive here on Windows/Linux; the Clerk
    // bridge consumes them from argv. Either way, bring the window forward.
    if (argv.some((a) => a.startsWith(`${cloudConfig.deepLinkScheme}://${RENDERER_HOST}`))) {
      log.info('received deep link')
    }
    showMainWindow()
  })
  app.on('open-url', () => showMainWindow())
  app.on('activate', () => {
    if (!getMainWindow()) createMainWindow(defaultChrome(resolvedTheme(settings.get())))
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
    cloudSync.dispose()
    tokenBridge.dispose()
    systemAccent.dispose()
    settings.flush()
    history.flush()
  })
  app.on('will-quit', () => {
    clerk?.cleanup()
    tray?.destroy()
    overlay.destroy()
  })
  void quitting
}
