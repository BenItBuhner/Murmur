import './proto.css'
import { createRoot } from 'react-dom/client'
import { useClock } from './clock'
import { Baseline } from './Baseline'
import { Inkline } from './concepts/Inkline'
import { MoodAurora } from './concepts/MoodAurora'
import { GlyphLoom } from './concepts/GlyphLoom'
import { Constellation } from './concepts/Constellation'
import { ContextChips } from './concepts/ContextChips'

export const CONCEPTS = {
  baseline: Baseline,
  inkline: Inkline,
  aurora: MoodAurora,
  loom: GlyphLoom,
  constellation: Constellation,
  chips: ContextChips
} as const

function App(): React.JSX.Element {
  const t = useClock()
  const name = (new URLSearchParams(location.search).get('c') ??
    'baseline') as keyof typeof CONCEPTS
  const C = CONCEPTS[name] ?? Baseline
  // The overlay window is anchored to the bottom; give every concept the same stage.
  return (
    <div className="dark relative h-full w-full" style={{ background: '#0b0b0c' }}>
      <div className="absolute inset-x-0 bottom-6 top-0">
        <C t={t} />
      </div>
    </div>
  )
}

// ?zoom=1.6 scales the stage for recording (video capture is always 1x).
const zoom = new URLSearchParams(location.search).get('zoom')
if (zoom) document.documentElement.style.zoom = zoom

createRoot(document.getElementById('root')!).render(<App />)
