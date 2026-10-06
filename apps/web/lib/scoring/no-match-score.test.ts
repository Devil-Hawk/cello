// The 0-100 match score is retired (migration 20261009000201): nothing writes
// jobs.match_score and no screen, route or prompt may read it. The columns stay in
// the database for one release, so a stray reader would quietly show nothing.
// This walks the source and fails naming every file that still mentions it, so a
// reader missed by hand cannot ship.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const DIRS = ['app', 'components', 'lib', 'hooks', 'prompts']
const SKIP_DIR = new Set(['node_modules', '.next'])
// The dead targeting.minScore setting still says match_score in a doc comment. The role type work rewrites that file.
const ALLOWED_FILES = new Set(['lib/targeting.ts'])

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (!SKIP_DIR.has(name)) yield* walk(full)
    } else if (/\.(ts|tsx|md)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      yield full
    }
  }
}

describe('the retired match score', () => {
  it('is not read or written anywhere in app, components, lib, hooks or prompts', () => {
    const offenders: string[] = []
    for (const d of DIRS) {
      const dir = path.join(ROOT, d)
      try {
        statSync(dir)
      } catch {
        continue
      }
      for (const file of walk(dir)) {
        const text = readFileSync(file, 'utf8')
        const rel = path.relative(ROOT, file)
        if (!ALLOWED_FILES.has(rel) && /match_score|matchScore|match_details|matchDetails/.test(text)) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})
