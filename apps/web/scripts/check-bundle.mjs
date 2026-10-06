// Bundle limits of the dimensional layer (blueprint 4.0a), checked over the
// production build's manifest:
//   - three and React Three Fiber never appear in a route's first-load JS
//   - the chunks that do carry them (loaded on idle) total at most 200 KB gzipped
//   - no route's first-load JS grows more than 5 KB gzipped over the baseline
//
//   node scripts/check-bundle.mjs                   check .next against bundle-baseline.json
//   node scripts/check-bundle.mjs --write-baseline  record the current sizes as the baseline
//
// Run from apps/web after `next build`. With no baseline file the growth check
// is skipped and the sizes are printed, so the first CI build can make one.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const THREE_ASYNC_MAX = 200 * 1024
export const ROUTE_GROWTH_MAX = 5 * 1024

/**
 * @param {object} input
 * @param {Record<string, string[]>} input.routes      route -> first-load chunk paths
 * @param {Record<string, number>} input.chunkGzip      chunk path -> gzipped bytes (every chunk)
 * @param {Record<string, boolean>} input.chunkHasThree chunk path -> mentions three's renderer
 * @param {Record<string, number>} [input.baseline]     route -> first-load gzipped bytes
 * @returns {{ ok: boolean, failures: string[], firstLoad: Record<string, number>, threeAsync: number }}
 */
export function checkBundle({ routes, chunkGzip, chunkHasThree, baseline }) {
  const failures = []
  const firstLoad = {}
  const inFirstLoad = new Set()
  for (const [route, chunks] of Object.entries(routes)) {
    firstLoad[route] = chunks.reduce((sum, c) => sum + (chunkGzip[c] ?? 0), 0)
    for (const c of chunks) {
      inFirstLoad.add(c)
      if (chunkHasThree[c]) failures.push(`${route}: first-load chunk ${c} contains three`)
    }
    const base = baseline?.[route]
    if (base !== undefined && firstLoad[route] - base > ROUTE_GROWTH_MAX) {
      failures.push(
        `${route}: first-load ${kb(firstLoad[route])} is ${kb(firstLoad[route] - base)} over its baseline ${kb(base)} (limit ${kb(ROUTE_GROWTH_MAX)})`,
      )
    }
  }
  let threeAsync = 0
  for (const [chunk, hasThree] of Object.entries(chunkHasThree)) {
    if (hasThree && !inFirstLoad.has(chunk)) threeAsync += chunkGzip[chunk] ?? 0
  }
  if (threeAsync > THREE_ASYNC_MAX) {
    failures.push(`the 3D chunks total ${kb(threeAsync)} gzipped (limit ${kb(THREE_ASYNC_MAX)})`)
  }
  return { ok: failures.length === 0, failures, firstLoad, threeAsync }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const full = path.join(dir, e)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function readBuild(nextDir) {
  const manifest = JSON.parse(readFileSync(path.join(nextDir, 'app-build-manifest.json'), 'utf8'))
  const routes = {}
  for (const [route, chunks] of Object.entries(manifest.pages ?? {})) {
    if (route.endsWith('/page')) routes[route] = chunks.filter((c) => c.endsWith('.js'))
  }
  const chunkGzip = {}
  const chunkHasThree = {}
  for (const file of walk(path.join(nextDir, 'static'))) {
    if (!file.endsWith('.js')) continue
    const rel = path.relative(nextDir, file).split(path.sep).join('/')
    const buf = readFileSync(file)
    chunkGzip[rel] = gzipSync(buf, { level: 9 }).length
    chunkHasThree[rel] = buf.includes('WebGLRenderer')
  }
  return { routes, chunkGzip, chunkHasThree }
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const nextDir = path.resolve(here, '..', process.env.NEXT_DIST_DIR || '.next')
  const baselinePath = path.join(here, 'bundle-baseline.json')
  const build = readBuild(nextDir)
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : undefined
  const result = checkBundle({ ...build, baseline })

  for (const [route, bytes] of Object.entries(result.firstLoad).sort()) {
    console.log(`${route.padEnd(48)} ${kb(bytes).padStart(10)}`)
  }
  console.log(`3D chunks (async): ${kb(result.threeAsync)}`)

  if (process.argv.includes('--write-baseline')) {
    writeFileSync(baselinePath, JSON.stringify(result.firstLoad, null, 2) + '\n')
    console.log(`wrote ${path.relative(process.cwd(), baselinePath)}`)
    return
  }
  if (!baseline) console.log('no bundle-baseline.json: the growth check was skipped')
  if (!result.ok) {
    for (const f of result.failures) console.error(`FAIL ${f}`)
    process.exit(1)
  }
  console.log('bundle check passed')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
