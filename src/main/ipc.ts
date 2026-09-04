import { readFileSync } from 'node:fs'
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { getSttProvider, STT_PRESETS, type SttConfig } from '@core/stt'
import { chatComplete, listChatModels } from '@core/llm/client'
import { runPipeline } from '@core/text/pipeline'
import { buildSttPrompt } from '@core/text/dictionary'
import { IPC } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import type { AppInfo, HistoryEntry, ProviderTestResult } from '@shared/types'
import fixtureWav from '../../resources/fixtures/jfk.wav?asset'
import type { DictationController } from './dictation/session'
import { friendlyError } from './dictation/session'
import type { HookService } from './hotkeys/hook'
import { injectText, injectionBackendName } from './inject'
import { sessionType } from './inject/linux'
import { getLogPath } from './logger'
import type { SettingsStore, SettingsPatch } from './store/settings'
import type { HistoryStore } from './store/history'
import { showMainWindow } from './windows/main-window'

export interface IpcDeps {
  settings: SettingsStore
  history: HistoryStore
  controller: DictationController
  hook: HookService
  onEnabledChange: (enabled: boolean) => void
  quit: () => void
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

export function registerIpc(deps: IpcDeps): void {
  const { settings, history, controller, hook } = deps

  settings.on('change', (next: Settings) => broadcast(IPC.settingsChanged, next))
  history.on('added', (entry: HistoryEntry) => broadcast(IPC.historyAdded, entry))
  hook.on('capture', (c) => broadcast(IPC.hotkeyCaptured, { ...c, final: false }))
  hook.on('captured', (c) => broadcast(IPC.hotkeyCaptured, { ...c, final: true }))

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

  ipcMain.handle(IPC.sttListModels, async (_e, override?: { kind?: Settings['stt']['kind']; baseUrl?: string; apiKey?: string }) => {
    const s = settings.get()
    const cfg: SttConfig = { kind: override?.kind ?? s.stt.kind, baseUrl: override?.baseUrl ?? s.stt.baseUrl, apiKey: override?.apiKey ?? settings.getSecret('stt'), model: s.stt.model, language: s.stt.language, timeoutMs: 15000 }
    try { return { ok: true, models: await getSttProvider(cfg.kind).listModels(cfg) } }
    catch (err) { return { ok: false, models: [], error: friendlyError(err) } }
  })

  ipcMain.handle(IPC.dictationToggle, () => controller.toggle())
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron, hookBackend: hook.backend, injectionBackend: injectionBackendName(), sessionType: process.platform === 'linux' ? sessionType() : undefined, userDataPath: app.getPath('userData'), logPath: getLogPath() }))
  ipcMain.handle(IPC.pipelinePreview, (_e, raw: string) => runPipeline(raw, controller.pipelineOptions(settings.get())))
  ipcMain.handle(IPC.sttListModels + ':presets', () => STT_PRESETS)
}
