// Source-level checks for the sourcing-correctness migrations, like
// lib/security/migration-grants.test.ts: they prove the SQL TEXT has the shape
// it claims. supabase/checks/gmail_suggestion_cleanup.sql and
// supabase/checks/clear_unverified_board_jobs.sql are the runtime proof.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(__dirname, '../../../../supabase/migrations')
const read = (name: string) => readFileSync(path.join(DIR, name), 'utf8')
const code = (sql: string) => sql.replace(/--[^\n]*/g, '')

describe('20261005200001 delete_unreferenced_gmail_suggestions', () => {
  const sql = code(read('20261005200001_delete_unreferenced_gmail_suggestions.sql'))

  it('reads every foreign key into companies from the catalog, so none is missed', () => {
    expect(sql).toMatch(/pg_catalog\.pg_constraint/)
    expect(sql).toMatch(/confrelid = 'public\.companies'::regclass/)
    expect(sql).toMatch(/not exists \(select 1 from %s r where r\.%I = c\.id\)/)
  })

  it('refuses a composite key instead of guessing', () => {
    expect(sql).toMatch(/raise exception/)
  })

  it('only targets rows Gmail suggested', () => {
    expect(sql).toMatch(/metadata->>''source'' = ''gmail''/)
    expect(sql).toMatch(/metadata->>''suggested'' = ''true''/)
  })

  it('is not callable over the API', () => {
    expect(sql).toMatch(/revoke execute on function public\.delete_unreferenced_gmail_suggestions\(\) from public, anon, authenticated/)
    expect(sql).not.toMatch(/\bgrant\b/i)
  })
})
