// sessionDoor( is called only from an API route and extensionDoor( only from the
// fill routes. A page, a component or a library helper that minted a proof for
// itself would make the proof worthless.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const SKIP = new Set(['node_modules', '.next', '.next-verify', '.next-3311', 'public', '.turbo'])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')

/** Files (relative to apps/web) that call `name(` and are not allowed to. */
function offenders(files: { rel: string; text: string }[], name: string, allowed: (rel: string) => boolean): string[] {
  const call = new RegExp(`\\b${name}\\(`)
  return files.filter((f) => call.test(stripComments(f.text)) && !allowed(f.rel)).map((f) => f.rel)
}

const files = sourceFiles(ROOT).map((full) => ({ rel: path.relative(ROOT, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') }))

const isRoute = (rel: string) => /^app\/api\/.+\/route\.ts$/.test(rel)
const isFill = (rel: string) => /^app\/api\/fill\/.+\.ts$/.test(rel)
const isDoorsModule = (rel: string) => rel === 'lib/commands/doors.ts'

describe('where a proof may be minted', () => {
  it('calls sessionDoor( only from an API route', () => {
    expect(offenders(files, 'sessionDoor', (rel) => isRoute(rel) || isDoorsModule(rel))).toEqual([])
  })

  it('calls extensionDoor( only from the fill routes', () => {
    expect(offenders(files, 'extensionDoor', (rel) => isFill(rel) || isDoorsModule(rel))).toEqual([])
  })

  it('flags a planted call from a page and from a library file', () => {
    const planted = [
      { rel: 'app/(app)/jobs/page.tsx', text: 'const ctx = await sessionDoor(request)' },
      { rel: 'lib/helpers/x.ts', text: 'extensionDoor({ userId })' },
      { rel: 'app/api/outreach/send/route.ts', text: 'await sessionDoor(request)' },
      { rel: 'lib/helpers/y.ts', text: '// sessionDoor( in a comment is not a call' },
    ]
    expect(offenders(planted, 'sessionDoor', isRoute)).toEqual(['app/(app)/jobs/page.tsx'])
    expect(offenders(planted, 'extensionDoor', isFill)).toEqual(['lib/helpers/x.ts'])
  })

  it('finds the three send routes and the doors module, so the scan is reading real files', () => {
    expect(files.some((f) => f.rel === 'app/api/outreach/send/route.ts')).toBe(true)
    expect(files.some((f) => isDoorsModule(f.rel))).toBe(true)
  })
})
