import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { exposeClerkBridge } from '@clerk/electron/preload'
import { IPC, type ThemeReport } from '@shared/ipc'
import type { Settings, SttProviderKind } from '@shared/settings'
import type {
  CloudConfig,
  RendererAuthState,
  SyncStatus,
  TokenRequest,
  TokenResponse
} from '@shared/cloud'
import type {
  AppInfo,
  DictationEvent,
  HistoryEntry,
  HotkeyCapture,
  ProviderTestResult
} from '@shared/types'
import type { UpdateStatus } from '@shared/updates'

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
  theme: {
    systemAccent: (): Promise<string | null> => ipcRenderer.invoke(IPC.themeSystemAccent),
    onSystemAccentChanged: (cb: (hex: string | null) => void): Unsub =>
      on(IPC.themeSystemAccentChanged, cb),
    report: (report: ThemeReport): Promise<void> => ipcRenderer.invoke(IPC.themeReport, report)
  },
  history: {
    list: (limit?: number, offset?: number): Promise<{ entries: HistoryEntry[]; total: number }> =>
      ipcRenderer.invoke(IPC.historyList, limit, offset),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.historyDelete, id),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.historyClear),
    reinsert: (id: string): Promise<InjectResultDto> => ipcRenderer.invoke(IPC.historyReinsert, id),
    onAdded: (cb: (e: HistoryEntry) => void): Unsub => on(IPC.historyAdded, cb),
    onChanged: (cb: () => void): Unsub => on(IPC.historyChanged, cb)
  },
  cloud: {
    config: (): Promise<CloudConfig> => ipcRenderer.invoke(IPC.cloudConfig),
    status: (): Promise<SyncStatus> => ipcRenderer.invoke(IPC.cloudStatus),
    onStatus: (cb: (s: SyncStatus) => void): Unsub => on(IPC.cloudStatusChanged, cb),
    reportAuth: (state: RendererAuthState): Promise<SyncStatus> =>
      ipcRenderer.invoke(IPC.cloudAuthState, state),
    onTokenRequest: (cb: (req: TokenRequest) => void): Unsub => on(IPC.cloudTokenRequest, cb),
    respondToken: (res: TokenResponse): void => ipcRenderer.send(IPC.cloudTokenResponse, res),
    syncNow: (): Promise<void> => ipcRenderer.invoke(IPC.cloudSyncNow),
    removeDevice: (deviceId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.cloudRemoveDevice, deviceId),
    deleteData: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.cloudDeleteData),
    setHistorySync: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.cloudSetHistorySync, enabled),
    skipAccount: (): Promise<boolean> => ipcRenderer.invoke(IPC.cloudSkipAccount)
  },
  updates: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesStatus),
    onStatus: (cb: (s: UpdateStatus) => void): Unsub => on(IPC.updatesStatusChanged, cb),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesCheck),
    download: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesDownload),
    cancelDownload: (): Promise<void> => ipcRenderer.invoke(IPC.updatesCancelDownload),
    install: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesInstall),
    skip: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updatesSkip),
    reveal: (): Promise<void> => ipcRenderer.invoke(IPC.updatesReveal),
    openReleases: (): Promise<void> => ipcRenderer.invoke(IPC.updatesOpenReleases),
    ackUpdated: (): Promise<void> => ipcRenderer.invoke(IPC.updatesAckUpdated)
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
// Token cache + OAuth transport for @clerk/electron/react. Harmless when no cloud is configured:
// the renderer only mounts ClerkProvider when it receives a publishable key from main.
exposeClerkBridge()
