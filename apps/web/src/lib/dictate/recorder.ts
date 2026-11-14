import { downsample, encodeWav, rms } from './wav'

/** Shorter than this is a slip of the finger, not a dictation (desktop drops these too). */
export const MIN_SECONDS = 0.3

export interface Recording {
  wav: Blob
  seconds: number
  level: number
}

/**
 * Microphone capture to 16 kHz mono WAV. The stream is opened per dictation and closed after, so
 * the browser's recording indicator is only on while you speak.
 */
export class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: ScriptProcessorNode | null = null
  private chunks: Float32Array[] = []
  onLevel: (level: number) => void = () => undefined

  get active(): boolean {
    return !!this.ctx
  }

  private starting: Promise<void> | null = null

  /** Opens the microphone; a stop() that comes first waits for it, so the mic is never left on. */
  start(): Promise<void> {
    this.starting ??= this.open().finally(() => (this.starting = null))
    return this.starting
  }

  private async open(): Promise<void> {
    if (this.ctx) return
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    this.ctx = new AudioContext()
    // Created after the permission prompt, outside the gesture: Safari starts it suspended.
    await this.ctx.resume().catch(() => undefined)
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.node = this.ctx.createScriptProcessor(4096, 1, 1)
    this.chunks = []
    this.node.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0))
      this.chunks.push(data)
      this.onLevel(Math.min(1, rms(data) * 6))
    }
    source.connect(this.node)
    this.node.connect(this.ctx.destination)
  }

  /** Stop and return the clip, or null when nothing usable was recorded. */
  async stop(): Promise<Recording | null> {
    await this.starting?.catch(() => undefined)
    const ctx = this.ctx
    if (!ctx) return null
    const rate = ctx.sampleRate
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    await ctx.close().catch(() => undefined)
    this.ctx = null
    this.node = null
    this.stream = null
    this.onLevel(0)
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const all = new Float32Array(total)
    let o = 0
    for (const c of this.chunks) {
      all.set(c, o)
      o += c.length
    }
    this.chunks = []
    const seconds = total / rate
    if (seconds < MIN_SECONDS) return null
    const pcm = downsample(all, rate)
    const bytes = encodeWav(pcm)
    return { wav: new Blob([bytes as BlobPart], { type: 'audio/wav' }), seconds, level: rms(pcm) }
  }
}
