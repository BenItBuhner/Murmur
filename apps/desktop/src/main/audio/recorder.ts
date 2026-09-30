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
import {
  SAMPLE_RATE,
  TestAudioStream,
  type TestAudioClip,
  type TestAudioSource
} from './test-audio'

const log = createLogger('recorder')

interface Capture {
  chunks: Int16Array[]
  samples: number
  stopped: (() => void) | null
  timer: NodeJS.Timeout | null
  /** Set when a clip on disk stands in for the microphone (`MURMUR_TEST_AUDIO_FILE`). */
  fixture: TestAudioStream | null
}

/**
 * Main-process side of microphone capture. The overlay renderer streams 16 kHz Int16 PCM chunks
 * over IPC (about 32 KB/s) and we accumulate them per session so a renderer hiccup never loses
 * audio. An optional duration cap, if the user enabled it, is enforced by the session controller.
 *
 * With a test-audio source (development builds only), a clip on disk is streamed into the
 * capture from this process at the microphone's pace instead: the renderer is not asked for
 * audio, no device is opened, and nothing is played. `ended` is emitted for the session when
 * the clip is spent.
 */
export class Recorder extends EventEmitter {
  private captures = new Map<string, Capture>()
  private config: AudioConfigureMessage | null = null
  status: AudioStatusMessage = { ready: false, warm: false }
  lastLevel = 0

  constructor(
    private overlay: OverlayWindow,
    private readonly testAudio: TestAudioSource | null = null
  ) {
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
    const cap: Capture = { chunks: [], samples: 0, stopped: null, timer: null, fixture: null }
    this.captures.set(sessionId, cap)
    if (this.testAudio) {
      this.startFixture(this.testAudio, sessionId, cap)
      return
    }
    this.overlay.send(IPC.audioStart, { sessionId, includePreBuffer })
  }

  /**
   * The stand-in microphone: the clip streams into this capture at real time, from this process
   * straight into the path the renderer's chunks take, so no renderer, input device or output is
   * involved. A clip that cannot be read leaves the capture empty (the dictation is "too short").
   */
  private startFixture(source: TestAudioSource, sessionId: string, cap: Capture): void {
    const tag = sessionId.slice(0, 8)
    let clip: TestAudioClip
    try {
      clip = source.next()
    } catch (err) {
      log.warn(`session ${tag}: fixture audio could not be read; the dictation gets no audio`, err)
      return
    }
    log.info(
      `session ${tag}: fixture audio ${clip.name} (${(clip.pcm.length / SAMPLE_RATE).toFixed(1)} s) stands in for the microphone`
    )
    cap.fixture = new TestAudioStream(clip.pcm, {
      chunk: (pcm, level) => this.push(sessionId, cap, pcm, level),
      ended: () => this.emit('ended', sessionId)
    })
    cap.fixture.start()
  }

  /** Ask the renderer to flush; resolves with all PCM (even if the renderer never answers). */
  stop(sessionId: string, graceMs = 1200): Promise<Int16Array> {
    const cap = this.captures.get(sessionId)
    if (cap?.fixture) {
      // The clip lives in this process: what is due up to now lands at once, no renderer to wait for.
      cap.fixture.stop()
      this.captures.delete(sessionId)
      return Promise.resolve(concatInt16(cap.chunks))
    }
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
    const cap = this.captures.get(sessionId)
    if (cap?.fixture) cap.fixture.stop()
    else this.overlay.send(IPC.audioStop, { sessionId })
    if (cap?.timer) clearTimeout(cap.timer)
    this.captures.delete(sessionId)
  }

  samplesFor(sessionId: string): number {
    return this.captures.get(sessionId)?.samples ?? 0
  }

  private onChunk(msg: AudioChunkMessage): void {
    const cap = this.captures.get(msg.sessionId)
    // A capture fed from a clip takes nothing from the renderer.
    if (!cap || cap.fixture) return
    this.push(msg.sessionId, cap, new Int16Array(msg.pcm), msg.level)
  }

  private push(sessionId: string, cap: Capture, pcm: Int16Array, level: number): void {
    cap.chunks.push(pcm)
    cap.samples += pcm.length
    this.lastLevel = level
    this.emit('chunk', sessionId, cap.samples, level)
  }

  private onStopped(msg: AudioStoppedMessage): void {
    const cap = this.captures.get(msg.sessionId)
    if (!cap) return
    cap.stopped?.()
  }
}
