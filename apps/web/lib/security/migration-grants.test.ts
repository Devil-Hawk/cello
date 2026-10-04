// Source-level ratchet for the anon-exposure lockdown (migrations
// 20261005000001-3). Like lib/access/lockdown.test.ts it proves the SQL TEXT
// has the shape it claims; supabase/checks/anon_exposure.sql is the runtime
// proof against a real database.
//
// The defect it guards: 20240131000000 default-granted every table, sequence
// and function to anon, and Postgres grants function EXECUTE to PUBLIC, so a
// forgotten REVOKE meant the public anon key could reach the object. Once the
// lockdown landed, any LATER migration that grants to anon or public would
// quietly undo it for that object, so none may.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations')
const LOCKDOWN_LAST = '20261005000003'

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** Returns each GRANT statement whose recipient list names anon or public. */
export function grantsToAnonOrPublic(sql: string): string[] {
  const text = stripComments(sql).toLowerCase()
  const hits: string[] = []
  for (const m of text.matchAll(/\bgrant\b([^;]*)/g)) {
    const stmt = m[1]
    // Everything after the LAST ` to ` is the recipient list; the object part
    // before it can legitimately say `schema public`.
    const idx = stmt.lastIndexOf(' to ')
    if (idx === -1) continue
    const recipients = stmt.slice(idx + 4).split(/\bwith\b/)[0]
    if (/\b(anon|public)\b/.test(recipients)) hits.push(`grant${stmt}`.replace(/\s+/g, ' ').trim())
  }
  return hits
}

function read(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')
}

describe('grantsToAnonOrPublic (the scanner itself)', () => {
  it.each([
    'grant select on public.x to anon;',
    'GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;',
    'grant execute on function public.f(uuid) to public;',
    'grant usage on sequence public.s to authenticated, anon;',
    'alter default privileges for role postgres in schema public grant all on tables to anon;',
    "execute format('grant all on %I to anon', t);",
  ])('flags %s', (sql) => {
    expect(grantsToAnonOrPublic(sql)).toHaveLength(1)
  })

  it.each([
    'grant execute on function public.f(uuid) to authenticated, service_role;',
    'grant all on schema public to authenticated;',
    'revoke all on public.x from anon;',
    'revoke execute on function public.f() from public, anon;',
    '-- grant all on public.x to anon',
    '/* grant all on public.x to public; */ select 1;',
  ])('ignores %s', (sql) => {
    expect(grantsToAnonOrPublic(sql)).toEqual([])
  })
})

describe('migrations after the anon lockdown', () => {
  const later = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f) && f.slice(0, 14) > LOCKDOWN_LAST)
    .sort()

  it('never grant table, sequence or function privileges to anon or public', () => {
    const offenders = later.flatMap((f) => grantsToAnonOrPublic(read(f)).map((g) => `${f}: ${g}`))
    expect(offenders).toEqual([])
  })
})

describe('the lockdown migrations', () => {
  it('drop the three unused SECURITY DEFINER RPCs', () => {
    const sql = read('20261005000001_drop_unused_security_definer_rpcs.sql')
    expect(sql).toMatch(/drop function if exists public\.get_application_stats\(uuid\)/)
    expect(sql).toMatch(/drop function if exists public\.get_upcoming_follow_ups\(uuid, integer\)/)
    expect(sql).toMatch(/drop function if exists public\.get_ghosted_applications\(uuid, integer\)/)
  })

  it('revoke function EXECUTE from public and anon, keep what signed-in sessions call, and assert it', () => {
    const sql = stripComments(read('20261005000002_revoke_function_execute_from_anon.sql'))
    expect(sql).toMatch(/alter default privileges for role postgres in schema public\s+revoke execute on functions from public, anon/)
    expect(sql).toMatch(/alter default privileges for role postgres\s+revoke execute on functions from public/)
    expect(sql).toMatch(/has_function_privilege\('anon'/)
    for (const fn of [
      'get_client_safe_preferences()',
      'set_onboarding_preferences(numeric, timestamptz)',
      'profile_is_demo(uuid)',
      'is_service_role_request()',
    ]) {
      expect(sql, `${fn} listed`).toContain(`'public.${fn}'`)
    }
    expect(sql).toMatch(/revoke execute on function %s from public, anon'/)
    expect(sql).toMatch(/grant execute on function %s to authenticated, service_role'/)
  })

  it('guards every revoke and grant so a function missing on production cannot abort the migration', () => {
    // Production was bootstrapped from free_tier_migration.sql and may lack
    // functions the 20240131* migrations create. No bare per-function
    // revoke/grant may remain: each goes through to_regprocedure.
    const sql = stripComments(read('20261005000002_revoke_function_execute_from_anon.sql'))
    expect(sql).not.toMatch(/(?:^|;)\s*(?:revoke|grant) execute on function\s+public\.(?!set_limit)/im)
    expect(sql.match(/to_regprocedure\(sig\) is not null/g)?.length).toBeGreaterThanOrEqual(2)
    expect(sql).toMatch(/where to_regprocedure\(f\) is not null/)
    expect(sql).toMatch(/to_regprocedure\('public\.set_limit\(real\)'\) is not null/)
  })

  it('revokes EXECUTE from every non-extension function in public, by exact signature', () => {
    // Every function a migration creates in public must be named in the
    // revoke migration or dropped by the first one: a new function that skips
    // both would keep PUBLIC EXECUTE.
    const created = new Set<string>()
    for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => /^\d{14}_.+\.sql$/.test(n) && n.slice(0, 14) <= LOCKDOWN_LAST)) {
      const sql = stripComments(read(f))
      for (const m of sql.matchAll(/create (?:or replace )?function\s+public\.(\w+)/gi)) created.add(m[1].toLowerCase())
    }
    const handled = (
      stripComments(read('20261005000001_drop_unused_security_definer_rpcs.sql')) +
      stripComments(read('20261005000002_revoke_function_execute_from_anon.sql')) +
      stripComments(read('20261004194501_prune_stale_rows.sql'))
    ).toLowerCase()
    const missing = [...created].filter((name) => !new RegExp(`(?:function (?:if exists )?|')public\\.${name}\\(`).test(handled))
    expect(missing).toEqual([])
  })

  it('drop the open jobs policies, revoke anon on tables and sequences, and assert it', () => {
    const sql = stripComments(read('20261005000003_close_anon_and_open_jobs_policies.sql'))
    expect(sql).toMatch(/drop policy if exists "Service role can insert jobs" on public\.jobs/)
    expect(sql).toMatch(/drop policy if exists "Service role can update jobs" on public\.jobs/)
    expect(sql).toMatch(/revoke all on all tables in schema public from anon/)
    expect(sql).toMatch(/revoke all on all sequences in schema public from anon/)
    expect(sql).toMatch(/alter default privileges for role postgres in schema public revoke all on tables from anon/)
    expect(sql).toMatch(/alter default privileges for role postgres in schema public revoke all on sequences from anon/)
    expect(sql).toMatch(/has_table_privilege\('anon'/)
    expect(sql).toMatch(/polroles = '\{0\}'::oid\[\]/)
  })

  it('leave the original open policies where they were declared (history is not rewritten)', () => {
    expect(read('20240131000001_initial_schema.sql')).toMatch(/create policy "Service role can insert jobs"/)
  })
})
