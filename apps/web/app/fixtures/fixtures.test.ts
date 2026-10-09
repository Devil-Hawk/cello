import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fixturesOn } from '@/lib/depth/fixtures-flag'

const DIR = path.join(process.cwd(), 'app/fixtures')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = path.join(dir, e)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const files = walk(DIR).filter((f) => !f.endsWith('.test.ts'))

describe('fixtures flag', () => {
  it('is on for a fixture build or a preview only', () => {
    expect(fixturesOn({})).toBe(false)
    expect(fixturesOn({ VERCEL_ENV: 'production' })).toBe(false)
    expect(fixturesOn({ CELLO_FIXTURES: '1' })).toBe(true)
    expect(fixturesOn({ VERCEL_ENV: 'preview' })).toBe(true)
  })
})

describe('fixture pages', () => {
  it('has pages to read', () => {
    expect(files.some((f) => f.endsWith('layout.tsx'))).toBe(true)
  })

  it('never calls Supabase', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/supabase/i)
  })

  it('mounts at most two canvases a page', () => {
    for (const f of files.filter((p) => p.endsWith('page.tsx'))) {
      const src = readFileSync(f, 'utf8')
      const n = (src.match(/<(Mark|WorkingMark|Canvas)[\s/>]/g) ?? []).length
      expect(n, f).toBeLessThanOrEqual(2)
    }
  })

  it('404s through the layout when the flag is off', () => {
    expect(readFileSync(path.join(DIR, 'layout.tsx'), 'utf8')).toContain('notFound()')
  })
})
