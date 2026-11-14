/* eslint-disable @typescript-eslint/no-require-imports -- plain Node recorder script */
// Quick visual check: screenshots of each concept at fixed moments of the take.
const { chromium } = require('playwright')
const out = process.argv[2]
const names = ['baseline', 'inkline', 'aurora', 'loom', 'constellation', 'chips']
const times = [300, 2500, 5200, 8300, 9200, 10400]
;(async () => {
  const b = await chromium.launch()
  await Promise.all(
    names.map(async (n) => {
      const p = await b.newPage({ viewport: { width: 640, height: 200 } })
      const errs = []
      p.on('pageerror', (e) => errs.push(String(e)))
      await p.goto(`http://localhost:5199/?rec&c=${n}`)
      await p.waitForFunction(() => window.__takeStart)
      const start = await p.evaluate(() => window.__takeStart)
      for (const t of times) {
        const wait = start + t - Date.now()
        if (wait > 0) await p.waitForTimeout(wait)
        await p.screenshot({ path: `${out}/${n}-${String(t).padStart(5, '0')}.png` })
      }
      if (errs.length) console.log(n, errs)
    })
  )
  await b.close()
})()
