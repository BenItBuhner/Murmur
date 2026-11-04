import { BrowserWindow, ipcMain } from 'electron'
import {
  IPC,
  type PhoneMicAnswerMessage,
  type PhoneMicEventMessage,
  type PhoneMicStatus
} from '@shared/ipc'
import type { CloudSync } from '../cloud/sync-engine'
import type { Recorder } from '../audio/recorder'
import type { DictationController } from '../dictation/session'
import type { SettingsStore } from '../store/settings'
import type { OverlayWindow } from '../windows/overlay'
import { PhoneMicHost, type CloudSource, type DictationSource } from './host'

export { PhoneMicHost } from './host'

export interface PhoneMicDeps {
  settings: SettingsStore
  cloud: CloudSync
  controller: DictationController
  recorder: Recorder
  overlay: OverlayWindow
}

/**
 * Phone as microphone (docs/phone-microphone.md): wires the host to the stores, the overlay
 * renderer and the settings window. One call from the app's startup; everything else lives here.
 */
export function installPhoneMic(deps: PhoneMicDeps): PhoneMicHost {
  const { settings, overlay } = deps
  const host = new PhoneMicHost({
    enabled: () => settings.get().audio.phoneMic,
    onSettingsChange: (cb) => {
      let last = settings.get().audio.phoneMic
      let lastName = settings.get().cloud.deviceName
      const listener = (): void => {
        const s = settings.get()
        if (s.audio.phoneMic === last && s.cloud.deviceName === lastName) return
        last = s.audio.phoneMic
        lastName = s.cloud.deviceName
        cb()
      }
      settings.on('change', listener)
      return () => settings.off('change', listener)
    },
    cloud: deps.cloud as unknown as CloudSource,
    dictation: deps.controller as unknown as DictationSource,
    levels: deps.recorder,
    overlay: {
      offer: (m) => void overlay.whenReady().then(() => overlay.send(IPC.phoneMicOffer, m)),
      send: (linkId, m) => overlay.send(IPC.phoneMicSend, { linkId, message: m }),
      close: (linkId) => overlay.send(IPC.phoneMicClose, { linkId })
    }
  })
  ipcMain.on(IPC.phoneMicAnswer, (_e, m: PhoneMicAnswerMessage) => host.onAnswer(m))
  ipcMain.on(IPC.phoneMicEvent, (_e, m: PhoneMicEventMessage) => host.onEvent(m))
  ipcMain.handle(IPC.phoneMicStatus, (): PhoneMicStatus => host.getStatus())
  host.on('status', (status: PhoneMicStatus) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.phoneMicStatusChanged, status)
    }
  })
  host.start()
  return host
}
