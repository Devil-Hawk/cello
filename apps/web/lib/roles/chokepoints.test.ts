// Source-level checks for roles/judge: the model is asked in one file only, and the migration has the shape it claims
// (the runtime proof is its own DO block, run with psql).

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DIR = __dirname
const code = (sql: string) => sql.replace(/--[^\n]*/g, '')

describe('the free door is the only way a roles step reaches a model', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))

  it('no file under lib/roles but free-door.ts names callLlm or makeIngestModelCall', () => {
    expect(files).toContain('free-door.ts')
    const offenders = files.filter((f) => f !== 'free-door.ts' && /\b(callLlm|makeIngestModelCall)\b/.test(code(readFileSync(path.join(DIR, f), 'utf8'))))
    expect(offenders).toEqual([])
    expect(/\bcallLlm\b/.test(readFileSync(path.join(DIR, 'free-door.ts'), 'utf8'))).toBe(true)
  })

  it('nothing under lib/roles opens a client of its own', () => {
    for (const f of files) expect(readFileSync(path.join(DIR, f), 'utf8'), f).not.toMatch(/\bfetch\(|from 'openai'|@langchain|embedding/i)
  })

  it('judge.ts reaches both steps only through judgeCall', () => {
    const judge = readFileSync(path.join(DIR, 'judge.ts'), 'utf8')
    expect(judge).toMatch(/step: 'role\.requirements'/)
    expect(judge).toMatch(/step: 'role\.evidence'/)
    expect(judge.match(/judgeCall\(/g)).toHaveLength(2)
  })
})

describe('20261022000400 roles_judge', () => {
  const sql = code(readFileSync(path.resolve(DIR, '../../../../supabase/migrations/20261022000400_roles_judge.sql'), 'utf8'))

  it('adds the four columns and the band values', () => {
    for (const c of ['band text', 'readings jsonb', 'prov jsonb', 'judged_at timestamptz']) expect(sql).toContain(c)
    expect(sql).toMatch(/band in \('strong', 'possible', 'stretch', 'cannot_assess'\)/)
    expect(sql).toMatch(/update public\.person_roles set band = chance where band is null/)
  })

  it('clears the judgement when a posting changes, and only the waiting mark when the resume changes', () => {
    expect(sql).toMatch(/band = null, readings = null, prov = null, judged_at = null/)
    expect(sql).toMatch(/after update of resume_text on public\.profiles/)
    expect(sql).toMatch(/update public\.person_roles set judged_at = null where user_id = new\.id/)
  })

  it('keeps the budget to the service role, with an atomic call counter nobody else can run', () => {
    expect(sql).toMatch(/alter table public\.judge_budget enable row level security/)
    expect(sql).toMatch(/revoke all on public\.judge_budget from public, anon, authenticated/)
    expect(sql).toMatch(/revoke all on function public\.take_judge_call\(date, uuid, integer, integer\) from public, anon, authenticated/)
    expect(sql).toMatch(/for update/)
    expect(sql).not.toMatch(/\buser_id\b[^;]*judge_budget|judge_budget[^;]*\buser_id uuid/)
  })

  it('seeds the roles.match routine on and ends with a self-check and a schema reload', () => {
    expect(sql).toMatch(/'roles\.match', interval '30 minutes'/)
    expect(sql).toMatch(/do \$\$[\s\S]*raise exception 'take_judge_call gave/)
    expect(sql.trim()).toMatch(/notify pgrst, 'reload schema';$/)
  })
})
