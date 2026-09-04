import type { MurmurApi } from './index'
import type { MurmurOverlayApi } from './overlay'

declare global {
  interface Window {
    murmur: MurmurApi
    murmurOverlay: MurmurOverlayApi
  }
}

export {}
