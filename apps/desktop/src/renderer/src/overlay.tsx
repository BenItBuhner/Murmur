import './styles/globals.css'
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { OverlayState } from '@shared/types'
import { Overlay } from './overlay/Overlay'
import { MicCapture } from './overlay/capture'
import { playSound, setSoundVolume } from './overlay/sounds'

const bridge = window.murmurOverlay

function App(): React.JSX.Element {
  const [state, setState] = useState<OverlayState>({ phase: 'idle' })
  const [level, setLevel] = useState(0)
  const [micError, setMicError] = useState<string | undefined>()

  useEffect(() => {
    const capture = new MicCapture({
      onChunk: (sessionId, pcm, lvl) => bridge.sendChunk({ sessionId, pcm, level: lvl }),
      onLevel: (lvl) => {
        setLevel(lvl)
        bridge.sendLevel(lvl)
      },
      onStatus: (status) => {
        setMicError(status.error)
        bridge.sendStatus(status)
      },
      onStopped: (sessionId, totalSamples) =>
        bridge.sendStopped({ sessionId, sampleRate: 16000, totalSamples })
    })
    const unsubs = [
      bridge.onState((s) => setState(s)),
      bridge.onPlaySound((name) => playSound(name)),
      bridge.onAudioConfigure((cfg) => {
        setSoundVolume(cfg.soundVolume)
        capture.configure(cfg).catch(() => undefined)
      }),
      bridge.onAudioStart((m) => {
        capture.start(m.sessionId, m.includePreBuffer).catch(() => undefined)
      }),
      bridge.onAudioStop((m) => capture.stop(m.sessionId))
    ]
    bridge.sendStatus({ ready: false, warm: false })
    return () => unsubs.forEach((u) => u())
  }, [])

  return <Overlay state={state} level={level} micError={micError} />
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
