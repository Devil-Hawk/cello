// Renders the still objects once, in a browser, and writes them as webp at 1x
// and 2x into public/depth. Stills are images, never canvases (blueprint 4.0a).
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs pnpm depth:stills <base-url>
//
// <base-url> serves /fixtures/depth-stills, so a preview deploy or a local
// `next start` built with CELLO_FIXTURES=1. Playwright is not a dependency of
// the app: point PLAYWRIGHT_MODULE at an install, or have `playwright` resolve.

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The same names as STILLS in components/ui/contract.ts.
const STILLS = ['quiet', 'empty', 'mark']

const base = process.argv[2]
if (!base) {
  console.error('usage: pnpm depth:stills <base-url>')
  process.exit(2)
}

const mod = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = mod.default ?? mod
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'depth')
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 })
  for (const name of STILLS) {
    for (const dpr of [1, 2]) {
      await page.goto(`${base.replace(/\/$/, '')}/fixtures/depth-stills?still=${name}&dpr=${dpr}`)
      await page.waitForFunction(() => window.__stillReady === true, null, { timeout: 30000 })
      const url = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/webp', 0.92))
      const file = path.join(out, `${name}@${dpr}x.webp`)
      writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'))
      console.log(`wrote ${path.relative(process.cwd(), file)}`)
    }
  }
} finally {
  await browser.close()
}
