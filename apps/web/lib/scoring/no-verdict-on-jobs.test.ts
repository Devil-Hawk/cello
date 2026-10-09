// What Cello concludes about a role is per person, so it lives on that person's
// own row (public.person_roles), never on the shared posting (public.jobs). This
// walks the source and fails naming every query that selects, filters, orders or
// writes a verdict column on `jobs`, so a reader missed by hand cannot ship.
// It also fails on any mention of the model-read requirements this replaced
// (requirement_items, lib/scoring/requirements): the posting reader's own record,
// jobs.requirements, is the only source of what a posting asks for.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const DIRS = ['app', 'components', 'lib', 'hooks', 'prompts', 'scripts']
const SKIP_DIR = new Set(['node_modules', '.next'])
const SELF = 'lib/scoring/no-verdict-on-jobs.test.ts'

const VERDICT = /\b(want_p|want_reason|want_detail|chance_detail|blocked_reasons|fit_assessed_at|requirement_items)\b|\bchance\b/
const RETIRED_REQUIREMENTS = /requirement_items|lib\/scoring\/requirements|extract-role-requirements/

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

/** The text of a call that starts at `open` (the index of its opening parenthesis), and the index after it. */
function balanced(text: string, open: number): { body: string; end: number } {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return { body: text.slice(open, i + 1), end: i + 1 }
  }
  return { body: text.slice(open), end: text.length }
}

/** Every query chain that starts on the jobs table: `.from('jobs')`, with the calls chained after it. person_jobs (what ownedJobsQuery reads) is the person's own role row and carries their verdict by design. */
export function jobsChains(text: string): string[] {
  const out: string[] = []
  const starts = [...text.matchAll(/\.from\(\s*['"]jobs['"]\s*\)/g)]
  for (const m of starts) {
    let i = (m.index ?? 0) + m[0].length
    let chain = m[0]
    if (m[0].endsWith('(')) {
      const call = balanced(text, i - 1)
      chain += call.body.slice(1)
      i = call.end
    }
    for (;;) {
      const rest = text.slice(i)
      const next = /^\s*\.\s*([A-Za-z_]+)\s*\(/.exec(rest)
      if (!next) break
      const open = i + next[0].length - 1
      const call = balanced(text, open)
      chain += '.' + next[1] + call.body
      i = call.end
    }
    out.push(chain)
  }
  return out
}

/** A chain with the person's own row embedded is allowed to name the verdict columns inside that embed. */
export function withoutPersonRolesEmbed(chain: string): string {
  return chain.replace(/person_roles(?:!inner)?\([^)]*\)/g, '')
}

describe('jobsChains', () => {
  it('finds a verdict column read from jobs and ignores the same names inside a person_roles embed', () => {
    const bad = "const r = await admin.from('jobs').select('id, chance').eq('id', x)"
    const good = "const r = await admin.from('jobs').select('id, person_roles!inner(chance, want_p)').eq('person_roles.user_id', u)"
    const own = "const r = await admin.from('person_roles').select('chance, want_p').eq('user_id', u)"
    expect(jobsChains(bad).some((c) => VERDICT.test(withoutPersonRolesEmbed(c)))).toBe(true)
    expect(jobsChains(good).some((c) => VERDICT.test(withoutPersonRolesEmbed(c)))).toBe(false)
    expect(jobsChains(own)).toEqual([])
  })

  it('follows a chain across lines, and leaves the person_jobs view alone', () => {
    const multi = "await admin\n  .from('jobs')\n  .select('id')\n  .update({ want_p: 0.5 })\n  .eq('id', x)"
    expect(jobsChains(multi).some((c) => /want_p/.test(c))).toBe(true)
    expect(jobsChains("ownedJobsQuery(admin, u, 'id, chance_detail')")).toEqual([])
    expect(jobsChains("admin.from('person_jobs').select('id, chance')")).toEqual([])
  })
})

describe('no per person verdict on jobs', () => {
  it('is never selected, filtered, ordered or written on the jobs table, and the model-read requirements are gone', () => {
    const offenders: string[] = []
    for (const d of DIRS) {
      const dir = path.join(ROOT, d)
      try {
        statSync(dir)
      } catch {
        continue
      }
      for (const file of walk(dir)) {
        const rel = path.relative(ROOT, file)
        if (rel === SELF) continue
        const text = readFileSync(file, 'utf8')
        if (RETIRED_REQUIREMENTS.test(text)) offenders.push(rel + ': names the retired requirements reader')
        for (const chain of jobsChains(text)) {
          const hit = VERDICT.exec(withoutPersonRolesEmbed(chain))
          if (hit) offenders.push(rel + ': ' + hit[0] + ' on jobs')
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
