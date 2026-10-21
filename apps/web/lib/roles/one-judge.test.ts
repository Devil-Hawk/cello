// The one judge stays the only judge. This reads the source, so the next copy of a relevance rule
// (a query twin, a SQL twin, an in-memory twin, a second dealbreaker check) fails here instead of
// drifting from lib/roles/keep.ts in silence.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** Tests run with cwd = apps/web. */
const ROOT = process.cwd()
const SCAN = ['lib', 'app', 'components']
const THIS = path.join('lib', 'roles', 'one-judge.test.ts')
const JUDGE = path.join('lib', 'roles', 'keep.ts')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (name === 'node_modules' || name === '.next') continue
    const rel = path.join(dir, name)
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(name) && rel !== THIS) out.push(rel)
  }
  return out
}

const files = SCAN.flatMap((d) => walk(d))
const text = new Map(files.map((f) => [f, readFileSync(path.join(ROOT, f), 'utf8')]))
const hits = (re: RegExp, except?: string) => files.filter((f) => f !== except && re.test(text.get(f)!))

describe('one judge', () => {
  it('reads source files (a broken walk must not pass silently)', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(text.get(JUDGE)).toContain('export function keepsRole')
  })

  it.each([
    ['applyRoleTargets', /applyRoleTargets/],
    ['targetVerdict(', /targetVerdict\(/],
    ['role_outside_targets', /role_outside_targets/],
    ['rankJobsByTargetTitles', /rankJobsByTargetTitles/],
    ['prioritiseByTargetTitles', /prioritiseByTargetTitles/],
  ])('has no %s anywhere under lib, app or components', (_name, re) => {
    expect(hits(re)).toEqual([])
  })

  it.each([
    ['judgeForPerson', /\bjudgeForPerson\b/],
    ['checkConstraints', /\bcheckConstraints\b/],
  ])('has no use of %s outside the judge: it is internal to lib/roles/keep.ts', (_name, re) => {
    expect(hits(re, JUDGE)).toEqual([])
  })

  it('lets only scoring and the shortlist eval import blockReasons: a second path to the dealbreakers must be on purpose', () => {
    const scripts = readdirSync(path.join(ROOT, 'scripts')).filter((n) => n.endsWith('.ts')).map((n) => path.join('scripts', n))
    const reads = (f: string) => (text.get(f) ?? readFileSync(path.join(ROOT, f), 'utf8'))
    const importers = [...files, ...scripts].filter(
      (f) => !f.endsWith('.test.ts') && /import\s*\{[^}]*\bblockReasons\b[^}]*\}\s*from\s*['"][^'"]*\/keep['"]/.test(reads(f))
    )
    expect(importers.sort()).toEqual([path.join('lib', 'scoring', 'pipeline.ts'), path.join('scripts', 'eval-shortlist.ts')])
  })
})
