// Source test: strings that said something untrue on a live page and were
// removed by the harm-out package must not come back. Narrow on purpose, it
// pins only those strings. The broad copy scan (emoji, em dashes, glossary)
// belongs to the ui-hygiene package. Comments count: reword rather than allow.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const WEB_ROOT = process.cwd()

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue
      if (full === path.join(WEB_ROOT, 'app', 'api')) continue
      out.push(...walk(full))
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) out.push(full)
  }
  return out
}

const rel = (f: string) => path.relative(WEB_ROOT, f).split(path.sep).join('/')

const LIVE_FILES = [...walk(path.join(WEB_ROOT, 'app')), ...walk(path.join(WEB_ROOT, 'components'))]

// Anything on a live page.
const BANNED_EVERYWHERE: RegExp[] = [
  /bypass permissions/i, // the toggle was removed, Auto already runs tools without a pause
  /check interval/i, // the stored 15 minutes was never the real cadence
  /new this week/i, // counted by first seen, now "Posted this week" by posting date
  /\bswept\b|first sweep/i, // the check line says "Checked" / "Not checked yet"
  /\btok\b/, // token counts were wrong for metered calls (case-sensitive on purpose)
  /Token budget/, // Settings has "thinking-token budget", which is a different thing
  /\bhourly\b/i, // companies are not checked hourly
]

// Run vocabulary, on Today only.
const BANNED_TODAY: RegExp[] = [
  /Agent activity/,
  /View runs/,
  /Last run/,
  /agent runs/,
  /Start a run/,
  /This run/,
  /matching run/,
]

function hits(files: string[], patterns: RegExp[]): string[] {
  const found: string[] = []
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const p of patterns) if (p.test(line)) found.push(`${rel(file)}:${i + 1} ${p} ${line.trim().slice(0, 80)}`)
      })
  }
  return found
}

describe('untrue copy stays out of live UI files', () => {
  it('scans real files', () => {
    expect(LIVE_FILES.length).toBeGreaterThan(100)
  })

  it('has none of the removed strings', () => {
    expect(hits(LIVE_FILES, BANNED_EVERYWHERE)).toEqual([])
  })

  it('has no run vocabulary on Today', () => {
    const today = LIVE_FILES.filter((f) => {
      const r = rel(f)
      return r === 'app/(app)/dashboard/page.tsx' || (r.startsWith('components/dashboard/') && !r.slice(21).includes('/'))
    })
    expect(today.length).toBeGreaterThan(3)
    expect(hits(today, BANNED_TODAY)).toEqual([])
  })
})
