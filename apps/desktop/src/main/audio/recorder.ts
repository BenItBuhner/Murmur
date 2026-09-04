import { EventEmitter } from 'node:events'
import { ipcMain } from 'electron'
import { concatInt16 } from '@core/audio/wav'
import {
  IPC,
  type AudioChunkMessage,
  type AudioConfigureMessage,
  type AudioStatusMessage,
  type AudioStoppedMessage
} from '@shared/ipc'
import type { OverlayWindow } from '../windows/overlay'
import { createLogger } from '../logger'

const log = createLogger('recorder')

interface Capture {
  chunks: Int16Array[]
  samples: number
  stopped: (() => void) | null
  timer: NodeJS.Timeout | null
}

/**
 * Main-process side of microphone capture. The overlay renderer streams 16 kHz Int16 PCM chunks
 * over IPC (about 32 KB/s) and we accumulate them per session so a renderer hiccup never loses
 * audio and the max-duration rule can be enforced here.
 */
export class Recorder extends EventEmitter {
  private captures = new Map<string, Capture>()
  private config: AudioConfigureMessage | null = null
  status: AudioStatusMessage = { ready: false, warm: false }
  lastLevel = 0

  constructor(private overlay: OverlayWindow) {
    super()
    ipcMain.on(IPC.audioChunk, (_e, msg: AudioChunkMessage) => this.onChunk(msg))
    ipcMain.on(IPC.audioStopped, (_e, msg: AudioStoppedMessage) => this.onStopped(msg))
    ipcMain.on(IPC.audioStatus, (_e, msg: AudioStatusMessage) => {
      const changed =
        msg.ready !== this.status.ready ||
        msg.error !== this.status.error ||
        msg.deviceLabel !== this.status.deviceLabel
      this.status = msg
      this.emit('status', msg)
      if (!changed) return
      if (msg.error) log.warn(`microphone: ${msg.error}`)
      else if (msg.ready)
        log.info(
          `microphone ready${msg.deviceLabel ? ` (${msg.deviceLabel})` : ''}${msg.warm ? ', warm' : ''}`
        )
      else log.info('microphone released')
    })
    ipcMain.on(IPC.audioLevel, (_e, level: number) => {
      this.lastLevel = level
      this.emit('level', level)
    })
  }

  configure(cfg: AudioConfigureMessage): void {
    this.config = cfg
    void this.overlay.whenReady().then(() => this.overlay.send(IPC.audioConfigure, cfg))
  }

  /** Re-send configuration after the overlay renderer (re)loads. */
  resend(): void {
    if (this.config) this.overlay.send(IPC.audioConfigure, this.config)
  }

  start(sessionId: string, includePreBuffer: boolean): void {
    this.captures.set(sessionId, { chunks: [], samples: 0, stopped: null, timer: null })
    this.overlay.send(IPC.audioStart, { sessionId, includePreBuffer })
  }

  /** Ask the renderer to flush; resolves with all PCM (even if the renderer never answers). */
  stop(sessionId: string, graceMs = 1200): Promise<Int16Array> {
    const cap = this.captures.get(sessionId)
    this.overlay.send(IPC.audioStop, { sessionId })
    if (!cap) return Promise.resolve(new Int16Array(0))
    return new Promise((resolve) => {
      const finish = (): void => {
        if (cap.timer) clearTimeout(cap.timer)
        this.captures.delete(sessionId)
        resolve(concatInt16(cap.chunks))
      }
      cap.stopped = finish
      cap.timer = setTimeout(() => {
        log.warn(
          `recorder: renderer did not confirm stop for ${sessionId}; using ${cap.samples} samples`
        )
        finish()
      }, graceMs)
    })
  }

  cancel(sessionId: string): void {
    this.overlay.send(IPC.audioStop, { sessionId })
    const cap = this.captures.get(sessionId)
    if (cap?.timer) clearTimeout(cap.timer)
    this.captures.delete(sessionId)
  }

  samplesFor(sessionId: string): number {
    return this.captures.get(sessionId)?.samples ?? 0
  }

  private onChunk(msg: AudioChunkMessage): void {
    const cap = this.captures.get(msg.sessionId)
    if (!cap) return
    const pcm = new Int16Array(msg.pcm)
    cap.chunks.push(pcm)
    cap.samples += pcm.length
    this.lastLevel = msg.level
    this.emit('chunk', msg.sessionId, cap.samples, msg.level)
  }

  private onStopped(msg: AudioStoppedMessage): void {
    const cap = this.captures.get(msg.sessionId)
    if (!cap) return
    cap.stopped?.()
  }
}
