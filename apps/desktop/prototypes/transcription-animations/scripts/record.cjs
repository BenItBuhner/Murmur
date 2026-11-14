/* eslint-disable @typescript-eslint/no-require-imports -- plain Node recorder script */
// Records every concept (and the real pill) playing the shared script once, in real time, then
// trims each video so t = 0 lands on frame 0. Usage: node record.cjs <outdir>
const { chromium } = require('playwright')
const { execFileSync } = require('child_process')
const fs = require('fs')
const out = process.argv[2]
const names = ['baseline', 'inkline', 'aurora', 'loom', 'constellation', 'chips']
const W = 960
const H = 300
const DURATION = 12000
;(async () => {
  const b = await chromium.launch({ args: ['--force-device-scale-factor=1'] })
  for (const n of names) {
    const dir = `${out}/raw-${n}`
    fs.rmSync(dir, { recursive: true, force: true })
    const ctx = await b.newContext({
      viewport: { width: W, height: H },
      recordVideo: { dir, size: { width: W, height: H } }
    })
    const videoStart = Date.now()
    const p = await ctx.newPage()
    await p.goto(`http://localhost:5199/?rec&zoom=1.5&c=${n}`)
    await p.waitForFunction(() => window.__takeStart)
    const start = await p.evaluate(() => window.__takeStart)
    await p.waitForTimeout(start + DURATION + 300 - Date.now())
    await ctx.close()
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.webm'))
    const offset = (start - videoStart) / 1000
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-ss',
      String(offset),
      '-i',
      `${dir}/${file}`,
      '-t',
      String(DURATION / 1000),
      '-r',
      '30',
      '-c:v',
      'libx264',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      `${out}/${n}.mp4`
    ])
    console.log(n, 'offset', offset.toFixed(3))
  }
  await b.close()
})()
