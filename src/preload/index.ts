import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type { Settings, SttProviderKind } from '@shared/settings'
import type {
  AppInfo,
  DictationEvent,
  HistoryEntry,
  HotkeyCapture,
  ProviderTestResult
} from '@shared/types'

type Unsub = () => void
const on = <T>(channel: string, cb: (payload: T) => void): Unsub => {
  const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

export interface ModelListResult {
  ok: boolean
  models: string[]
  error?: string
}

export interface SttOverride {
  kind?: SttProviderKind
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface LlmOverride {
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface InjectResultDto {
  ok: boolean
  method: string
  ms: number
  error?: string
}

const api = {
  platform: process.platform,
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    patch: (patch: unknown): Promise<Settings> => ipcRenderer.invoke(IPC.settingsPatch, patch),
    reset: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsReset),
    onChange: (cb: (s: Settings) => void): Unsub => on(IPC.settingsChanged, cb)
  },
  secrets: {
    set: (slot: 'stt' | 'llm', value: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.secretSet, slot, value),
    has: (slot: 'stt' | 'llm'): Promise<boolean> => ipcRenderer.invoke(IPC.secretHas, slot)
  },
  history: {
    list: (limit?: number, offset?: number): Promise<{ entries: HistoryEntry[]; total: number }> =>
      ipcRenderer.invoke(IPC.historyList, limit, offset),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.historyDelete, id),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.historyClear),
    reinsert: (id: string): Promise<InjectResultDto> => ipcRenderer.invoke(IPC.historyReinsert, id),
    onAdded: (cb: (e: HistoryEntry) => void): Unsub => on(IPC.historyAdded, cb)
  },
  stt: {
    listModels: (override?: SttOverride): Promise<ModelListResult> =>
      ipcRenderer.invoke(IPC.sttListModels, override),
    test: (override?: SttOverride): Promise<ProviderTestResult> =>
      ipcRenderer.invoke(IPC.sttTest, override),
    presets: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.sttListModels + ':presets')
  },
  llm: {
    listModels: (override?: LlmOverride): Promise<ModelListResult> =>
      ipcRenderer.invoke(IPC.llmListModels, override),
    test: (override?: LlmOverride): Promise<ProviderTestResult> =>
      ipcRenderer.invoke(IPC.llmTest, override)
  },
  hotkeys: {
    startCapture: (): Promise<void> => ipcRenderer.invoke(IPC.hotkeyCaptureStart),
    stopCapture: (): Promise<void> => ipcRenderer.invoke(IPC.hotkeyCaptureStop),
    label: (keys: number[]): Promise<string> => ipcRenderer.invoke(IPC.hotkeyLabel, keys),
    onCaptured: (cb: (c: HotkeyCapture & { final: boolean }) => void): Unsub =>
      on(IPC.hotkeyCaptured, cb)
  },
  dictation: {
    toggle: (): Promise<void> => ipcRenderer.invoke(IPC.dictationToggle),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.dictationCancel),
    onState: (cb: (e: DictationEvent) => void): Unsub => on(IPC.dictationState, cb)
  },
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.appOpenExternal, url),
    openLogs: (): Promise<void> => ipcRenderer.invoke(IPC.appOpenLogs),
    setEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC.appSetEnabled, enabled),
    onEnabledChanged: (cb: (enabled: boolean) => void): Unsub => on(IPC.enabledChanged, cb),
    onNavigate: (cb: (route: string) => void): Unsub => on(IPC.navigate, cb),
    quit: (): Promise<void> => ipcRenderer.invoke(IPC.appQuit),
    completeOnboarding: (): Promise<void> => ipcRenderer.invoke(IPC.onboardingComplete)
  },
  inject: {
    test: (text: string): Promise<InjectResultDto> => ipcRenderer.invoke(IPC.injectTest, text)
  },
  pipeline: {
    preview: (
      raw: string
    ): Promise<{ text: string; pressEnter: boolean; stages: string[]; wordCount: number }> =>
      ipcRenderer.invoke(IPC.pipelinePreview, raw)
  }
}

export type MurmurApi = typeof api

contextBridge.exposeInMainWorld('murmur', api)
