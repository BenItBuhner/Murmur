import { readFileSync } from 'node:fs'
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { getSttProvider, STT_PRESETS, type SttConfig } from '@core/stt'
import { chatComplete, listChatModels } from '@core/llm/client'
import { runPipeline } from '@core/text/pipeline'
import { buildSttPrompt } from '@core/text/dictionary'
import { IPC, type ThemeReport } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { isHexColor } from '@shared/theme'
import type { CloudConfig, RendererAuthState, SyncStatus } from '@shared/cloud'
import type { AppInfo, HistoryEntry, ProviderTestResult } from '@shared/types'
import fixtureWav from '../../resources/fixtures/jfk.wav?asset'
import type { CloudSync } from './cloud/sync-engine'
import type { DictationController } from './dictation/session'
import { friendlyError } from './dictation/session'
import type { HookService } from './hotkeys/hook'
import { injectText, injectionBackendName } from './inject'
import { sessionType } from './inject/linux'
import { getLogPath } from './logger'
import type { SettingsStore, SettingsPatch } from './store/settings'
import type { HistoryStore } from './store/history'
import { showMainWindow, updateChrome } from './windows/main-window'

export interface IpcDeps {
  settings: SettingsStore
  history: HistoryStore
  controller: DictationController
  hook: HookService
  cloudConfig: CloudConfig
  cloud: CloudSync
  /** Current OS accent colour (`#rrggbb`) or null. */
  systemAccent: () => string | null
  onEnabledChange: (enabled: boolean) => void
  quit: () => void
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

export function registerIpc(deps: IpcDeps): void {
  const { settings, history, controller, hook, cloud, cloudConfig } = deps

  settings.on('change', (next: Settings) => broadcast(IPC.settingsChanged, next))
  history.on('added', (entry: HistoryEntry) => broadcast(IPC.historyAdded, entry))
  history.on('changed', () => broadcast(IPC.historyChanged, undefined))
  hook.on('capture', (c) => broadcast(IPC.hotkeyCaptured, { ...c, final: false }))
  hook.on('captured', (c) => broadcast(IPC.hotkeyCaptured, { ...c, final: true }))
  cloud.on('status', (status: SyncStatus) => broadcast(IPC.cloudStatusChanged, status))

  ipcMain.handle(IPC.cloudConfig, (): CloudConfig => cloudConfig)
  ipcMain.handle(IPC.cloudStatus, (): SyncStatus => cloud.getStatus())
  ipcMain.handle(IPC.cloudAuthState, (_e, state: RendererAuthState) => {
    cloud.setAuthState(state)
    return cloud.getStatus()
  })
  ipcMain.handle(IPC.cloudSyncNow, () => cloud.syncNow())
  ipcMain.handle(IPC.cloudRemoveDevice, async (_e, deviceId: string) => {
    try {
      return { ok: await cloud.removeDevice(deviceId) }
    } catch (err) {
      return { ok: false, error: friendlyError(err) }
    }
  })
  ipcMain.handle(IPC.cloudDeleteData, async () => {
    try {
      await cloud.deleteMyData()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: friendlyError(err) }
    }
  })
  ipcMain.handle(IPC.cloudSetHistorySync, (_e, enabled: boolean) => cloud.setHistorySync(!!enabled))
  ipcMain.handle(IPC.cloudSkipAccount, () => {
    if (cloudConfig.accountMode !== 'optional') return false
    settings.patch({ cloud: { accountSkipped: true } })
    return true
  })

  ipcMain.handle(IPC.themeSystemAccent, () => deps.systemAccent())
  ipcMain.handle(IPC.themeReport, (_e, report: ThemeReport) => {
    if (isHexColor(report?.background) && isHexColor(report?.foreground)) {
      updateChrome({ background: report.background, foreground: report.foreground })
    }
  })

  ipcMain.handle(IPC.settingsGet, () => settings.get())
  ipcMain.handle(IPC.settingsPatch, (_e, patch: SettingsPatch) => settings.patch(patch))
  ipcMain.handle(IPC.settingsReset, () => settings.reset())
  ipcMain.handle(IPC.secretSet, (_e, slot: 'stt' | 'llm', value: string) => {
    settings.setSecret(slot, value)
    return true
  })
  ipcMain.handle(IPC.secretHas, (_e, slot: 'stt' | 'llm') => settings.hasSecret(slot))

  ipcMain.handle(IPC.historyList, (_e, limit?: number, offset?: number) =>
    history.list(limit, offset)
  )
  ipcMain.handle(IPC.historyDelete, (_e, id: string) => history.delete(id))
  ipcMain.handle(IPC.historyClear, () => history.clear())
  ipcMain.handle(IPC.historyReinsert, async (_e, id: string) => {
    const entry = history.get(id)
    if (!entry) return { ok: false, error: 'Entry not found' }
    const s = settings.get()
    // Give the user a moment to focus the target window after clicking.
    await new Promise((r) => setTimeout(r, 900))
    return injectText(entry.finalText + (s.formatting.trailingSpace ? ' ' : ''), {
      method: s.injection.method,
      restoreClipboard: s.injection.restoreClipboard,
      restoreClipboardDelayMs: s.injection.restoreClipboardDelayMs,
      typeChunkSize: s.injection.typeChunkSize,
      typeChunkDelayMs: s.injection.typeChunkDelayMs,
      waitForKeysUp: () => hook.waitForKeysUp(1000)
    })
  })

  ipcMain.handle(
    IPC.sttListModels,
    async (
      _e,
      override?: { kind?: Settings['stt']['kind']; baseUrl?: string; apiKey?: string }
    ) => {
      const s = settings.get()
      const cfg: SttConfig = {
        kind: override?.kind ?? s.stt.kind,
        baseUrl: override?.baseUrl ?? s.stt.baseUrl,
        apiKey: override?.apiKey ?? settings.getSecret('stt'),
        model: s.stt.model,
        language: s.stt.language,
        timeoutMs: 15000
      }
      try {
        return { ok: true, models: await getSttProvider(cfg.kind).listModels(cfg) }
      } catch (err) {
        return { ok: false, models: [], error: friendlyError(err) }
      }
    }
  )

  ipcMain.handle(
    IPC.sttTest,
    async (
      _e,
      override?: {
        kind?: Settings['stt']['kind']
        baseUrl?: string
        apiKey?: string
        model?: string
      }
    ): Promise<ProviderTestResult> => {
      const s = settings.get()
      const cfg: SttConfig = {
        kind: override?.kind ?? s.stt.kind,
        baseUrl: override?.baseUrl ?? s.stt.baseUrl,
        apiKey: override?.apiKey ?? settings.getSecret('stt'),
        model: override?.model ?? s.stt.model,
        language: 'en',
        timeoutMs: 45000
      }
      try {
        const wav = new Uint8Array(readFileSync(fixtureWav))
        const res = await getSttProvider(cfg.kind).transcribe(
          { wav, prompt: buildSttPrompt([]) },
          cfg
        )
        const ok = /country/i.test(res.text)
        return {
          ok,
          latencyMs: res.latencyMs,
          text: res.text,
          message: ok
            ? `Transcribed the test clip in ${res.latencyMs} ms`
            : `Connected, but the transcript looks wrong: "${res.text.slice(0, 80)}"`
        }
      } catch (err) {
        const e = err as { suggestedModels?: string[] }
        return { ok: false, message: friendlyError(err), suggestedModels: e.suggestedModels ?? [] }
      }
    }
  )

  ipcMain.handle(
    IPC.llmListModels,
    async (_e, override?: { baseUrl?: string; apiKey?: string }) => {
      const conn = settings.llmConnection()
      try {
        return {
          ok: true,
          models: await listChatModels({
            baseUrl: override?.baseUrl ?? conn.baseUrl,
            apiKey: override?.apiKey ?? conn.apiKey
          })
        }
      } catch (err) {
        return { ok: false, models: [], error: friendlyError(err) }
      }
    }
  )

  ipcMain.handle(
    IPC.llmTest,
    async (
      _e,
      override?: { baseUrl?: string; apiKey?: string; model?: string }
    ): Promise<ProviderTestResult> => {
      const conn = settings.llmConnection()
      const cfg = {
        baseUrl: override?.baseUrl ?? conn.baseUrl,
        apiKey: override?.apiKey ?? conn.apiKey,
        model: override?.model ?? conn.model,
        timeoutMs: 20000
      }
      try {
        const res = await chatComplete(
          cfg,
          [
            {
              role: 'system',
              content:
                "Rewrite the user's dictated text with correct punctuation and capitalization and without filler words. Output only the text."
            },
            { role: 'user', content: 'um so this is a quick test of the uh formatting model' }
          ],
          { maxTokens: 768 }
        )
        const ok = res.text.trim().length > 0 && !/\bum\b|\buh\b/i.test(res.text)
        return {
          ok,
          latencyMs: res.latencyMs,
          text: res.text.trim(),
          message: ok
            ? `Formatted in ${res.latencyMs} ms`
            : `Model answered but did not clean the text: "${res.text.trim().slice(0, 80)}"`
        }
      } catch (err) {
        const e = err as { suggestedModels?: string[] }
        return { ok: false, message: friendlyError(err), suggestedModels: e.suggestedModels ?? [] }
      }
    }
  )

  ipcMain.handle(IPC.hotkeyCaptureStart, () => hook.startCapture())
  ipcMain.handle(IPC.hotkeyCaptureStop, () => hook.stopCapture())
  ipcMain.handle(IPC.hotkeyLabel, (_e, keys: number[]) => hook.labelFor(keys))

  ipcMain.handle(IPC.dictationToggle, () => controller.toggle())
  ipcMain.handle(IPC.dictationCancel, () => controller.handle({ type: 'cancel' }))

  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    hookBackend: hook.backend,
    injectionBackend: injectionBackendName(),
    sessionType: process.platform === 'linux' ? sessionType() : undefined,
    userDataPath: app.getPath('userData'),
    logPath: getLogPath()
  }))
  ipcMain.handle(IPC.appOpenExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle(IPC.appOpenLogs, () => shell.showItemInFolder(getLogPath()))
  ipcMain.handle(IPC.appSetEnabled, (_e, enabled: boolean) => deps.onEnabledChange(enabled))
  ipcMain.handle(IPC.appQuit, () => deps.quit())
  ipcMain.handle(IPC.onboardingComplete, () => {
    settings.patch({ onboardingComplete: true })
    cloud.completeOnboarding()
    showMainWindow('home')
  })

  ipcMain.handle(IPC.injectTest, async (_e, text: string) => {
    const s = settings.get()
    await new Promise((r) => setTimeout(r, 1200))
    return injectText(text, {
      method: s.injection.method,
      restoreClipboard: s.injection.restoreClipboard,
      restoreClipboardDelayMs: s.injection.restoreClipboardDelayMs,
      typeChunkSize: s.injection.typeChunkSize,
      typeChunkDelayMs: s.injection.typeChunkDelayMs,
      waitForKeysUp: () => hook.waitForKeysUp(1000)
    })
  })

  ipcMain.handle(IPC.pipelinePreview, (_e, raw: string) => {
    const s = settings.get()
    return runPipeline(raw, controller.pipelineOptions(s))
  })

  ipcMain.handle(IPC.sttListModels + ':presets', () => STT_PRESETS)
}
