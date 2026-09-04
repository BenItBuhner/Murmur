import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AudioChunkMessage,
  type AudioConfigureMessage,
  type AudioStartMessage,
  type AudioStatusMessage,
  type AudioStoppedMessage,
  type SoundName
} from '@shared/ipc'
import type { OverlayState } from '@shared/types'

type Unsub = () => void
const on = <T>(channel: string, cb: (payload: T) => void): Unsub => {
  const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  onState: (cb: (s: OverlayState) => void): Unsub => on(IPC.overlayState, cb),
  onPlaySound: (cb: (name: SoundName) => void): Unsub => on(IPC.overlayPlaySound, cb),
  onAudioConfigure: (cb: (cfg: AudioConfigureMessage) => void): Unsub => on(IPC.audioConfigure, cb),
  onAudioStart: (cb: (m: AudioStartMessage) => void): Unsub => on(IPC.audioStart, cb),
  onAudioStop: (cb: (m: { sessionId: string }) => void): Unsub => on(IPC.audioStop, cb),
  sendChunk: (m: AudioChunkMessage): void => ipcRenderer.send(IPC.audioChunk, m),
  sendStopped: (m: AudioStoppedMessage): void => ipcRenderer.send(IPC.audioStopped, m),
  sendStatus: (m: AudioStatusMessage): void => ipcRenderer.send(IPC.audioStatus, m),
  sendLevel: (level: number): void => ipcRenderer.send(IPC.audioLevel, level)
}

export type MurmurOverlayApi = typeof api

contextBridge.exposeInMainWorld('murmurOverlay', api)
