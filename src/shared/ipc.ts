/**
 * Single source of truth for IPC channel names. Main, preload and both renderers
 * import from here so a typo fails at compile time instead of silently at runtime.
 */
export const IPC = {
  // renderer -> main (invoke)
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsReset: 'settings:reset',
  secretSet: 'secret:set',
  secretHas: 'secret:has',
  historyList: 'history:list',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',
  historyReinsert: 'history:reinsert',
  sttListModels: 'stt:list-models',
  sttTest: 'stt:test',
  llmListModels: 'llm:list-models',
  llmTest: 'llm:test',
  hotkeyCaptureStart: 'hotkey:capture-start',
  hotkeyCaptureStop: 'hotkey:capture-stop',
  hotkeyLabel: 'hotkey:label',
  dictationToggle: 'dictation:toggle',
  dictationCancel: 'dictation:cancel',
  appInfo: 'app:info',
  appOpenExternal: 'app:open-external',
  appOpenLogs: 'app:open-logs',
  appSetEnabled: 'app:set-enabled',
  appQuit: 'app:quit',
  onboardingComplete: 'onboarding:complete',
  injectTest: 'inject:test',
  pipelinePreview: 'pipeline:preview',

  // main -> renderer (send)
  settingsChanged: 'settings:changed',
  historyAdded: 'history:added',
  hotkeyCaptured: 'hotkey:captured',
  dictationState: 'dictation:state',
  enabledChanged: 'app:enabled-changed',
  navigate: 'app:navigate',

  // overlay <-> main
  overlayState: 'overlay:state',
  overlayPlaySound: 'overlay:play-sound',
  audioConfigure: 'audio:configure',
  audioStart: 'audio:start',
  audioStop: 'audio:stop',
  audioChunk: 'audio:chunk',
  audioStopped: 'audio:stopped',
  audioStatus: 'audio:status',
  audioLevel: 'audio:level'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface AudioConfigureMessage {
  deviceId: string
  keepWarm: boolean
  preBufferMs: number
  noiseSuppression: boolean
  autoGainControl: boolean
  soundVolume: number
  theme: 'light' | 'dark'
}

export interface AudioStartMessage {
  sessionId: string
  includePreBuffer: boolean
}

export interface AudioChunkMessage {
  sessionId: string
  /** Int16 little-endian PCM, 16 kHz mono. */
  pcm: ArrayBuffer
  level: number
}

export interface AudioStoppedMessage {
  sessionId: string
  sampleRate: number
  totalSamples: number
}

export interface AudioStatusMessage {
  ready: boolean
  warm: boolean
  deviceLabel?: string
  error?: string
}

export type SoundName = 'start' | 'stop' | 'lock' | 'error' | 'cancel'
