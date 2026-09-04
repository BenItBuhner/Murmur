import type { AudioConfigureMessage } from '@shared/ipc'

const TARGET_RATE = 16000
const CHUNK_SAMPLES = 1024 // 64 ms at 16 kHz

// Runs on the audio rendering thread: converts float frames to Int16 and batches them.
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(${CHUNK_SAMPLES});
    this.fill = 0;
    this.sumSq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      this.sumSq += s * s;
      this.buf[this.fill++] = Math.round(s < 0 ? s * 32768 : s * 32767);
      if (this.fill === this.buf.length) {
        const rms = Math.sqrt(this.sumSq / this.buf.length);
        const out = this.buf;
        this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
        this.buf = new Int16Array(${CHUNK_SAMPLES});
        this.fill = 0;
        this.sumSq = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`

export interface CaptureEvents {
  onChunk: (sessionId: string, pcm: ArrayBuffer, level: number) => void
  onLevel: (level: number) => void
  onStatus: (status: {
    ready: boolean
    warm: boolean
    deviceLabel?: string
    error?: string
  }) => void
  onStopped: (sessionId: string, totalSamples: number) => void
}

interface Session {
  id: string
  samples: number
}

/**
 * Microphone capture that is always "warm" when allowed: the stream and AudioContext stay
 * open, a rolling pre-buffer keeps the last few hundred milliseconds, and starting a session
 * costs nothing but a flag flip. That is where the perceived snappiness of hold-to-talk comes from.
 */
export class MicCapture {
  private cfg: AudioConfigureMessage | null = null
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private preBuffer: Array<{ pcm: ArrayBuffer; level: number }> = []
  private session: Session | null = null
  private pendingStart: { id: string; includePreBuffer: boolean } | null = null
  private acquiring: Promise<void> | null = null
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private workletUrl: string | null = null
  private levelTick = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = 1500

  constructor(private events: CaptureEvents) {
    // A microphone plugged in (or a PulseAudio/CoreAudio device appearing) after launch should
    // bring the warm mic back without user action.
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (this.cfg?.keepWarm && !this.isWarm && !this.session)
        void this.ensure().catch(() => undefined)
    })
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.cfg?.keepWarm) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.cfg?.keepWarm && !this.isWarm) {
        this.retryDelay = Math.min(this.retryDelay * 1.6, 15000)
        void this.ensure().catch(() => undefined)
      }
    }, this.retryDelay)
  }

  async configure(cfg: AudioConfigureMessage): Promise<void> {
    const deviceChanged =
      this.cfg &&
      (this.cfg.deviceId !== cfg.deviceId ||
        this.cfg.noiseSuppression !== cfg.noiseSuppression ||
        this.cfg.autoGainControl !== cfg.autoGainControl)
    this.cfg = cfg
    if (deviceChanged && !this.session) await this.release()
    if (cfg.keepWarm) await this.ensure()
    else if (!this.session) await this.release()
  }

  async start(id: string, includePreBuffer: boolean): Promise<void> {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer)
      this.releaseTimer = null
    }
    if (this.session) {
      // Overlapping start: the previous session was stopped by main already; just switch.
      this.session = { id, samples: 0 }
      return
    }
    this.session = { id, samples: 0 }
    if (!this.ctx || this.ctx.state !== 'running') {
      this.pendingStart = { id, includePreBuffer }
      await this.ensure()
      if (this.pendingStart?.id !== id) return
      this.pendingStart = null
    }
    if (includePreBuffer && this.preBuffer.length) {
      for (const chunk of this.preBuffer) {
        this.session.samples += chunk.pcm.byteLength / 2
        this.events.onChunk(id, chunk.pcm.slice(0), chunk.level)
      }
    }
    this.preBuffer = []
  }

  stop(id: string): void {
    if (!this.session || this.session.id !== id) {
      this.events.onStopped(id, 0)
      return
    }
    const s = this.session
    this.session = null
    this.pendingStart = null
    this.events.onStopped(s.id, s.samples)
    if (this.cfg && !this.cfg.keepWarm) {
      this.releaseTimer = setTimeout(() => void this.release(), 4000)
    }
  }

  get isWarm(): boolean {
    return !!this.ctx && this.ctx.state === 'running'
  }

  private async ensure(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running' && this.stream) return
    if (this.acquiring) return this.acquiring
    this.acquiring = this.acquire().finally(() => (this.acquiring = null))
    return this.acquiring
  }

  private async acquire(): Promise<void> {
    const cfg = this.cfg
    try {
      const constraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: cfg?.noiseSuppression ?? true,
        autoGainControl: cfg?.autoGainControl ?? true
      }
      if (cfg?.deviceId && cfg.deviceId !== 'default')
        constraints.deviceId = { exact: cfg.deviceId }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      } catch (err) {
        if (cfg?.deviceId && cfg.deviceId !== 'default') {
          // Device unplugged: fall back to the default input rather than failing the session.
          delete constraints.deviceId
          stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
        } else throw err
      }
      this.retryDelay = 1500
      this.stream = stream
      let ctx: AudioContext
      try {
        ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' })
      } catch {
        ctx = new AudioContext({ latencyHint: 'interactive' })
      }
      if (ctx.sampleRate !== TARGET_RATE) {
        throw new Error(`Audio context refused 16 kHz (got ${ctx.sampleRate})`)
      }
      if (!this.workletUrl) {
        this.workletUrl = URL.createObjectURL(
          new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
        )
      }
      await ctx.audioWorklet.addModule(this.workletUrl)
      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1
      })
      node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) =>
        this.onChunk(e.data.pcm, e.data.rms)
      source.connect(node)
      if (ctx.state !== 'running') await ctx.resume()
      this.ctx = ctx
      this.node = node
      const track = stream.getAudioTracks()[0]
      this.events.onStatus({ ready: true, warm: true, deviceLabel: track?.label })
      track?.addEventListener('ended', () => {
        this.events.onStatus({ ready: false, warm: false, error: 'Microphone disconnected' })
        void this.release()
        if (this.cfg?.keepWarm) setTimeout(() => void this.ensure(), 1500)
      })
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      this.events.onStatus({ ready: false, warm: false, error: message })
      await this.release()
      this.scheduleRetry()
      throw err
    }
  }

  private onChunk(pcm: ArrayBuffer, rms: number): void {
    // Perceptual level: map -50 dBFS (room noise) .. -10 dBFS (loud speech) onto 0..1.
    const db = rms <= 1e-6 ? -120 : 20 * Math.log10(rms)
    const level = Math.max(0, Math.min(1, (db + 50) / 40))
    if (++this.levelTick % 2 === 0) this.events.onLevel(level)
    if (this.session) {
      this.session.samples += pcm.byteLength / 2
      this.events.onChunk(this.session.id, pcm, level)
      return
    }
    const maxChunks = Math.ceil(
      ((this.cfg?.preBufferMs ?? 0) / 1000) * (TARGET_RATE / CHUNK_SAMPLES)
    )
    if (maxChunks <= 0) return
    this.preBuffer.push({ pcm, level })
    while (this.preBuffer.length > maxChunks) this.preBuffer.shift()
  }

  private async release(): Promise<void> {
    this.preBuffer = []
    try {
      this.node?.disconnect()
    } catch {
      // ignore
    }
    this.node = null
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop()
      this.stream = null
    }
    if (this.ctx) {
      try {
        await this.ctx.close()
      } catch {
        // ignore
      }
      this.ctx = null
    }
    this.events.onStatus({ ready: false, warm: false })
  }
}
