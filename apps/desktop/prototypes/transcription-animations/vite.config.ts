import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Standalone prototype harness: renders the real overlay pill next to new concepts, all driven by
// one shared script (script.ts). Run from apps/desktop: npx vite --config prototypes/transcription-animations/vite.config.ts
const desktop = resolve(__dirname, '../..')
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve(desktop, 'src/renderer/src'),
      '@shared': resolve(desktop, 'src/shared'),
      '@core': resolve(desktop, 'src/core'),
      '@engine': resolve(desktop, '../../packages/text-engine/src'),
      '@backend': resolve(desktop, '../../packages/backend/convex')
    }
  },
  server: { port: 5199, strictPort: true }
})
