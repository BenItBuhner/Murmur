/* eslint-disable @typescript-eslint/no-require-imports -- plain Node renderer script */
// Renders a concept frame by frame (deterministic, any fps), optionally with a transparent
// background. Usage: node frames.cjs <concept> <outdir> [--fps 60] [--alpha] [--zoom 2] [--w 960 --h 300] [--from ms --to ms]
const { chromium } = require('playwright')
const fs = require('fs')
const a = process.argv.slice(2)
const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d)
const [name, out] = a
const fps = +opt('--fps', 30)
const alpha = a.includes('--alpha')
const W = +opt('--w', 960)
const H = +opt('--h', 300)
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const b = await chromium.launch()
  const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await p.goto(
    `http://localhost:5199/?frame&c=${name}&zoom=${opt('--zoom', 1.5)}${alpha ? '&alpha' : ''}`
  )
  await p.waitForFunction(() => window.__setT)
  const from = +opt('--from', 0)
  const to = +opt('--to', 15900)
  let i = 0
  for (let t = from; t <= to; t += 1000 / fps) {
    await p.evaluate((v) => window.__setT(v), t)
    await p.screenshot({
      path: `${out}/${String(i++).padStart(5, '0')}.png`,
      omitBackground: alpha
    })
  }
  await b.close()
  console.log(name, i, 'frames')
})()
