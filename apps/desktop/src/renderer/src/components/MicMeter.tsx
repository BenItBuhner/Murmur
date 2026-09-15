import React, { useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/lib/utils'

export interface MicDevice {
  deviceId: string
  label: string
}

export function useMicDevices(): {
  devices: MicDevice[]
  refresh: () => Promise<void>
  error?: string
} {
  const [devices, setDevices] = useState<MicDevice[]>([])
  const [error, setError] = useState<string>()
  const refresh = async (): Promise<void> => {
    try {
      // Labels are only exposed after permission; a short-lived stream grants it.
      let probe: MediaStream | null = null
      const first = await navigator.mediaDevices.enumerateDevices()
      if (!first.some((d) => d.kind === 'audioinput' && d.label)) {
        probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      }
      const all = await navigator.mediaDevices.enumerateDevices()
      probe?.getTracks().forEach((t) => t.stop())
      setDevices(
        all
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({
            deviceId: d.deviceId,
            label: d.label || `Microphone (${d.deviceId.slice(0, 6)})`
          }))
      )
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
  }
  useEffect(() => {
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [])
  return { devices, refresh, error }
}

/** Live input level for the selected device, rendered as a segmented meter. */
export function MicMeter({
  deviceId,
  thresholdDb,
  className
}: {
  deviceId: string
  thresholdDb?: number
  className?: string
}): React.JSX.Element {
  const [level, setLevel] = useState(0)
  const [db, setDb] = useState(-100)
  const [error, setError] = useState<string>()
  const raf = useRef(0)

  useEffect(() => {
    let ctx: AudioContext | null = null
    let stream: MediaStream | null = null
    let cancelled = false
    const run = async (): Promise<void> => {
      try {
        const constraints: MediaTrackConstraints = { channelCount: 1 }
        if (deviceId && deviceId !== 'default') constraints.deviceId = { exact: deviceId }
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
        if (cancelled) return
        ctx = new AudioContext()
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        src.connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        const tick = (): void => {
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
          const rms = Math.sqrt(sum / buf.length)
          setLevel(Math.min(1, rms * 4))
          setDb(rms <= 1e-9 ? -100 : 20 * Math.log10(rms))
          raf.current = requestAnimationFrame(tick)
        }
        tick()
        setError(undefined)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void run()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf.current)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [deviceId])

  const segments = 24
  const lit = Math.round(level * segments)
  const thresholdIdx =
    thresholdDb !== undefined
      ? Math.round(Math.min(1, Math.pow(10, thresholdDb / 20) * 4) * segments)
      : -1
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex h-3 items-center gap-[3px]">
        {Array.from({ length: segments }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'h-full flex-1 rounded-full transition-colors duration-75',
              i < lit ? (i > segments * 0.85 ? 'bg-record' : 'bg-success') : 'bg-input',
              i === thresholdIdx && 'ring-1 ring-foreground/50'
            )}
          />
        ))}
      </div>
      <div className="flex justify-between text-caption text-muted-foreground tabular-nums">
        <span>
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : db > -99 ? (
            `${db.toFixed(0)} dB`
          ) : (
            'silent'
          )}
        </span>
        {thresholdDb !== undefined && <span>speech threshold {thresholdDb} dB</span>}
      </div>
    </div>
  )
}
