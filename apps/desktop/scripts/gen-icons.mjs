// Generates the app icon and tray icons without any native image dependency.
// Run: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = (buf) => {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

/** Signed distance helpers evaluated with 4x4 supersampling for clean edges. */
function render(size, { background, bars, barColor, radiusRatio = 0.24 }) {
  const rgba = Buffer.alloc(size * size * 4)
  const SS = 4
  const bg = background ? hex(background) : null
  const fg = hex(barColor)
  const radius = size * radiusRatio
  const barW = size * 0.09
  const gap = size * 0.06
  const totalW = bars.length * barW + (bars.length - 1) * gap
  const x0 = (size - totalW) / 2
  const inRoundedRect = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius)
    const cy = Math.min(Math.max(y, radius), size - radius)
    return Math.hypot(x - cx, y - cy) <= radius
  }
  const inBars = (x, y) => {
    for (let i = 0; i < bars.length; i++) {
      const bx = x0 + i * (barW + gap)
      const h = size * bars[i]
      const by = (size - h) / 2
      // rounded caps
      const cx = Math.min(Math.max(x, bx + barW / 2), bx + barW / 2)
      const cy = Math.min(Math.max(y, by + barW / 2), by + h - barW / 2)
      if (Math.hypot(x - cx, y - cy) <= barW / 2) return true
    }
    return false
  }
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgCov = 0
      let barCov = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS
          const y = py + (sy + 0.5) / SS
          if (bg && inRoundedRect(x, y)) bgCov++
          if (inBars(x, y)) barCov++
        }
      }
      bgCov /= SS * SS
      barCov /= SS * SS
      const o = (py * size + px) * 4
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      if (bg) {
        r = bg[0] * bgCov
        g = bg[1] * bgCov
        b = bg[2] * bgCov
        a = bgCov
      }
      // composite bars over background
      r = fg[0] * barCov + r * (1 - barCov)
      g = fg[1] * barCov + g * (1 - barCov)
      b = fg[2] * barCov + b * (1 - barCov)
      a = barCov + a * (1 - barCov)
      rgba[o] = Math.round(r)
      rgba[o + 1] = Math.round(g)
      rgba[o + 2] = Math.round(b)
      rgba[o + 3] = Math.round(a * 255)
    }
  }
  return encodePng(size, size, rgba)
}

const BARS = [0.28, 0.5, 0.68, 0.5, 0.28]
const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, 'build'), { recursive: true })
mkdirSync(resolve(root, 'resources/tray'), { recursive: true })

writeFileSync(resolve(root, 'build/icon.png'), render(512, { background: '#141414', bars: BARS, barColor: '#ffffff' }))
writeFileSync(resolve(root, 'resources/icon.png'), render(256, { background: '#141414', bars: BARS, barColor: '#ffffff' }))
for (const [name, opts] of Object.entries({
  idle: { background: '#141414', bars: BARS, barColor: '#ffffff' },
  listening: { background: '#141414', bars: [0.36, 0.62, 0.8, 0.62, 0.36], barColor: '#ff5a36' },
  processing: { background: '#141414', bars: BARS, barColor: '#8ab4ff' },
  disabled: { background: '#141414', bars: BARS, barColor: '#6b6b6b' }
})) {
  writeFileSync(resolve(root, `resources/tray/${name}.png`), render(32, opts))
  writeFileSync(resolve(root, `resources/tray/${name}@2x.png`), render(64, opts))
  // Template-style monochrome for Linux panels that prefer flat icons.
  writeFileSync(resolve(root, `resources/tray/${name}-mono.png`), render(32, { background: null, bars: opts.bars, barColor: name === 'listening' ? '#ff5a36' : '#e5e5e5' }))
}
console.log('icons written')
