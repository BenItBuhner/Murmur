import type { SoundName } from '@shared/ipc'

let ctx: AudioContext | null = null
let volume = 0.35

export function setSoundVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v))
}

function context(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' })
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function tone(
  ac: AudioContext,
  freq: number,
  start: number,
  duration: number,
  gain: number,
  type: OscillatorType = 'sine'
): void {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(g).connect(ac.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

/** Short synthesized cues, in the spirit of Wispr Flow's start/stop pings. No asset files needed. */
export function playSound(name: SoundName): void {
  if (volume <= 0) return
  const ac = context()
  const t = ac.currentTime + 0.005
  const v = volume * 0.5
  switch (name) {
    case 'start':
      tone(ac, 660, t, 0.09, v)
      tone(ac, 990, t + 0.07, 0.11, v)
      break
    case 'stop':
      tone(ac, 880, t, 0.08, v)
      tone(ac, 587, t + 0.07, 0.12, v)
      break
    case 'lock':
      tone(ac, 660, t, 0.07, v)
      tone(ac, 880, t + 0.06, 0.07, v)
      tone(ac, 1174, t + 0.12, 0.12, v)
      break
    case 'cancel':
      tone(ac, 440, t, 0.06, v * 0.8)
      tone(ac, 330, t + 0.05, 0.1, v * 0.8)
      break
    case 'error':
      tone(ac, 220, t, 0.16, v * 0.9, 'triangle')
      tone(ac, 196, t + 0.12, 0.2, v * 0.9, 'triangle')
      break
  }
}
