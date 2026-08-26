// Ratchet: every public-schema table a 20260816* or 20260818* migration
// creates must ship RLS + full per-user CRUD policies — or, for a table with
// no direct end-user writer (service-role writes only), RLS + an owner
// SELECT policy alone (see SELECT_ONLY_TABLES below). This is a SOURCE-LEVEL
// test over the .sql files, same approach and same warning as
// lib/access/lockdown.test.ts: it proves the migration TEXT has the shape it
// claims, not that Postgres enforces it at runtime (there is no database in
// this test run).
//
// WHY A RATCHET AND NOT JUST lockdown.test.ts AGAIN
//   lockdown.test.ts pins two specific migrations by name, by design (each of
//   its assertions is tailored to that file's exact structure). This module
//   generalizes the ONE property that matters across every new table this
//   stage adds — "did anyone forget the RLS block" — so the NEXT migration
//   that lands in this band is checked automatically, without a new test file
//   per table.
//
// APPLYING lockdown.test.ts's LESSON (see that file's own header): a check
// that only looks for a policy's NAME as a bare substring would go green on a
// migration that named a policy "own interactions select" but forgot the `on
// public.interactions for select` clause under it — a real gap, since a
// misspelled `create policy` is still a `create policy` statement. The SAME
// lesson also applies one level deeper: a policy that has the right name AND
// op clause but grants `to public using (true)` (world-readable/writable,
// including anon) is a present-but-non-restrictive policy — the more
// dangerous vacuous-green case for a ratchet whose whole job is catching
// exactly this. checkTableRls() below requires BOTH the operation clause
// (bounded window after the named policy) AND, within that clause, `to
// authenticated` (not `to public`) and the `(select auth.uid()) = user_id`
// ownership predicate every real policy in this band carries.
//
// TWO IDIOMS, BOTH REAL IN THIS BAND
//   (A) literal named policies — interactions.sql, insights.sql,
//       company_merge_candidates in 20260816000002 — four separate
//       `create policy "own <table> <op>" on public.<table> for <op>` blocks.
//   (B) a looped format()-templated do-block — resume_claims.sql's
//       resume_claims/claim_evidence pair — `foreach t in array array[...]`
//       generating `format('own %s <op>', t)` / `on public.%I ... for <op>`
//       for every table in the array. Only checking idiom (A) would report a
//       false RED on resume_claims/claim_evidence, which is exactly the kind
//       of test that gets "fixed" by loosening it until it stops being useful
//       — so idiom (B) is checked structurally instead of being ignored.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations'
)

const CRUD_OPS = ['select', 'insert', 'update', 'delete'] as const
type CrudOp = (typeof CRUD_OPS)[number]

/** Strip `--` comment lines, same as lockdown.test.ts's stripComments — a
 *  commented-out `create policy` line (or a prose mention of one in a header)
 *  must never satisfy a check meant to prove the statement is LIVE. Proven
 *  load-bearing by this file's own mutation test below: without this, the
 *  comment text left behind by "delete the create-policy line, keep a
 *  trailing comment" still matched hasLiteralPolicy's regex on its own. */
function stripComments(source: string): string {
  // Trailing `--` comments are stripped too, not just whole-comment lines: a
  // live-but-permissive policy with `-- to authenticated (select auth.uid())
  // = user_id` tacked on the same line would otherwise smuggle the magic
  // phrases into the captured clause window and turn the ratchet vacuously
  // green. ponytail: naive strip — a `--` inside a SQL string literal would
  // be mangled, which makes the ratchet go RED (loud), never green.
  return source
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

/** Every `create table if not exists public.<name>` in a migration's SQL text. */
function publicTablesCreated(sql: string): string[] {
  const re = /create table if not exists public\.(\w+)/gi
  const out: string[] = []
  for (const m of sql.matchAll(re)) out.push(m[1])
  return out
}

function tableHasRlsEnabled(sql: string, table: string): boolean {
  return new RegExp(`alter table public\\.${table} enable row level security;`).test(sql)
}

/** Ownership predicate every real policy in this band uses: `(select
 *  auth.uid()) = user_id`, inside either a `using (...)` (select/delete) or
 *  `with check (...)` (insert) clause, or both (update). Checked as a bare
 *  substring test on the CLAUSE text (not the whole file) so a table that
 *  merely mentions auth.uid() somewhere unrelated can't satisfy it. */
const OWNER_PREDICATE_RE = /auth\.uid\(\)\)\s*=\s*user_id/i
const TO_AUTHENTICATED_RE = /\bto authenticated\b/i

/** Idiom (A): a literally-named policy whose `on public.<table> for <op>`
 *  clause follows the `create policy "own <table> <op>"` line within a
 *  bounded window — bounded so a same-named policy for a DIFFERENT table
 *  later in the file can never satisfy this table's check. The clause is
 *  then required to grant `to authenticated` (not `to public`/anon) AND
 *  carry the owner-column predicate — a present-but-permissive policy like
 *  `for select to public using (true)` matches the NAME/OP shape but must
 *  still go red, which is exactly what a ratchet whose job is catching
 *  vacuous-green RLS has to check (see lockdown.test.ts's header lesson,
 *  applied here to the "policy exists but grants everyone" case, not just
 *  the "policy line missing entirely" case). */
function hasLiteralPolicy(sql: string, table: string, op: CrudOp): boolean {
  const re = new RegExp(
    `create policy\\s+"own ${table} ${op}"[\\s\\S]{0,200}?on public\\.${table}\\s+for ${op}\\b([\\s\\S]{0,200}?);`,
    'i'
  )
  const m = re.exec(sql)
  if (!m) return false
  const clause = m[1]
  return TO_AUTHENTICATED_RE.test(clause) && OWNER_PREDICATE_RE.test(clause)
}

/** Idiom (B): `table` is one of the array literal's entries in a
 *  `foreach t in array array[...] ... end loop` block whose body generates
 *  `format('own %s <op>', t)` policies via `on public.%I ... for <op>` for
 *  every op — i.e. the SAME templated do-block resume_claims.sql uses to
 *  cover resume_claims AND claim_evidence without repeating four `create
 *  policy` statements per table. */
function hasLoopedPolicy(sql: string, table: string, op: CrudOp): boolean {
  const loopMatch = sql.match(/foreach\s+t\s+in\s+array\s+array\[([^\]]*)\][\s\S]*?end loop;/i)
  if (!loopMatch) return false
  const arrayEntries = loopMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  if (!arrayEntries.includes(table)) return false
  const body = loopMatch[0]
  if (!new RegExp(`'own %s ${op}'`, 'i').test(body)) return false
  // Isolate the quoted format() STRING for this op's `execute format(...)`
  // call — everything between `for <op>` and the `', format(` that closes
  // the quoted SQL string and starts the templating args — then require the
  // SAME "to authenticated" + owner-predicate shape idiom (A) requires. A
  // loop body that generates `for select to public using (true)` still
  // matches `for select` and the `'own %s select'` literal but must still
  // go red here.
  const clauseMatch = new RegExp(`for ${op}\\b([\\s\\S]{0,200}?)',\\s*format\\(`, 'i').exec(body)
  if (!clauseMatch) return false
  const clause = clauseMatch[1]
  return TO_AUTHENTICATED_RE.test(clause) && OWNER_PREDICATE_RE.test(clause)
}

/** Public-schema tables this stage intentionally does NOT give the full
 *  4-policy user-CRUD shape, and why. Empty today — every public table this
 *  band creates (company_merge_candidates, interactions, insights,
 *  resume_claims, claim_evidence) is plain per-user CRUD. Kept as the place a
 *  future migration documents a REAL exception (e.g. a table with no direct
 *  end-user writer) rather than inventing a bespoke skip inline. The
 *  mem0/langgraph schemas need no entry here at all: they are not `public.*`
 *  tables in the first place (20260816000006_memories.sql creates schema
 *  `mem0`, 20260817000001_langgraph_schema.sql creates schema `langgraph`,
 *  neither with a `create table ... public.*` statement), so
 *  publicTablesCreated() never surfaces them — the schema boundary IS the
 *  exemption, structurally, not a comment someone has to remember to write. */
const EXEMPT_PUBLIC_TABLES: Record<string, string> = {}

/** Tables in this band with NO direct end-user writer — every write is the
 *  service-role admin client (which bypasses RLS entirely), so PostgREST only
 *  ever needs to serve reads to the owning user. These get RLS + an owner
 *  SELECT policy and, deliberately, NO insert/update/delete policy at all
 *  (default-deny handles those verbs with no `using (false)` needed) — same
 *  shape and same justification as graph_threads
 *  (20260817000002_graph_threads.sql, outside this test's glob but the
 *  precedent this follows). trace_spans and eval_verdicts document this in
 *  their own migration headers; listed here so the ratchet checks the
 *  NARROWER shape they actually ship instead of either skipping them
 *  entirely (EXEMPT_PUBLIC_TABLES) or false-reporting them RED for missing
 *  insert/update/delete policies they were never meant to have. */
const SELECT_ONLY_TABLES = new Set(['trace_spans', 'eval_verdicts'])

interface TableRlsResult {
  ok: boolean
  missing: string[]
}

function checkTableRls(rawSql: string, table: string): TableRlsResult {
  if (table in EXEMPT_PUBLIC_TABLES) return { ok: true, missing: [] }
  const sql = stripComments(rawSql)
  const missing: string[] = []
  if (!tableHasRlsEnabled(sql, table)) missing.push('enable row level security')
  const requiredOps: readonly CrudOp[] = SELECT_ONLY_TABLES.has(table) ? ['select'] : CRUD_OPS
  for (const op of requiredOps) {
    if (!hasLiteralPolicy(sql, table, op) && !hasLoopedPolicy(sql, table, op)) missing.push(`${op} policy`)
  }
  return { ok: missing.length === 0, missing }
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => (f.startsWith('20260816') || f.startsWith('20260818')) && f.endsWith('.sql'))
  .sort()

describe('20260816*/20260818* migrations — every public table is RLS-ratcheted', () => {
  it('finds migration files to check (a broken glob must not pass silently)', () => {
    expect(files.length).toBeGreaterThanOrEqual(11)
  })

  it('finds at least the tables this stage is known to create (a broken parser must not pass silently)', () => {
    const allTables = files.flatMap((f) => publicTablesCreated(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')))
    expect(allTables).toEqual(
      expect.arrayContaining([
        'company_merge_candidates',
        'interactions',
        'insights',
        'resume_claims',
        'claim_evidence',
        'trace_spans',
        'eval_verdicts',
      ])
    )
  })

  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    const tables = publicTablesCreated(sql)
    for (const table of tables) {
      it(`${file}: public.${table} has RLS enabled and all four CRUD policies (or a documented exemption)`, () => {
        const result = checkTableRls(sql, table)
        expect(result.ok, `public.${table} in ${file} is missing: ${result.missing.join(', ')}`).toBe(true)
      })
    }
  }
})

describe('checkTableRls — mutation: a policy-stripped fixture goes RED', () => {
  // MEASURED, not reasoned: run against the real interactions.sql text this
  // check reports ok:true for 'interactions'. Deleting the DELETE policy's
  // `create policy` line (leaving its `on public.interactions for delete`
  // clause behind, mimicking a distracted edit that only removes half of one
  // policy block) is enough to flip checkTableRls to ok:false, catching
  // exactly the class of drift lockdown.test.ts's header warns about — a
  // migration that LOOKS complete because most of the policy text is still
  // there. Confirmed by hand before this file was finalized; the assertions
  // below re-run that same mutation on every test run rather than trusting
  // the one-time manual check.
  const REAL_SQL = readFileSync(path.join(MIGRATIONS_DIR, '20260816000004_interactions.sql'), 'utf8')

  it('the real migration passes (sanity baseline before mutating it)', () => {
    expect(checkTableRls(REAL_SQL, 'interactions')).toEqual({ ok: true, missing: [] })
  })

  it("stripping the delete policy's `create policy` line flips the check to red", () => {
    const mutated = REAL_SQL.replace('create policy "own interactions delete"', '-- create policy "own interactions delete" (removed by mutation test)')
    const result = checkTableRls(mutated, 'interactions')
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('delete policy')
  })

  it('a permissive policy hiding the magic phrases in a trailing comment is still red', () => {
    // The exact bypass the stage-2 re-verifier found: a world-readable policy
    // that keeps the ratchet's required phrases alive only inside a same-line
    // `--` comment. stripComments must remove the comment before matching.
    const fixture = `
      create table if not exists public.sneaky_table (
        id uuid primary key,
        user_id uuid not null
      );
      alter table public.sneaky_table enable row level security;
      create policy "own sneaky_table select" on public.sneaky_table for select to public using (true); -- to authenticated using ((select auth.uid()) = user_id)
      create policy "own sneaky_table insert" on public.sneaky_table for insert to public with check (true); -- to authenticated ((select auth.uid()) = user_id)
      create policy "own sneaky_table update" on public.sneaky_table for update to public using (true); -- to authenticated ((select auth.uid()) = user_id)
      create policy "own sneaky_table delete" on public.sneaky_table for delete to public using (true); -- to authenticated ((select auth.uid()) = user_id)
    `
    const result = checkTableRls(fixture, 'sneaky_table')
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['select policy', 'insert policy', 'update policy', 'delete policy'])
  })

  it('a table with `enable row level security` but zero policies is red on every op', () => {
    const fixture = `
      create table if not exists public.no_policies_table (
        id uuid primary key,
        user_id uuid not null
      );
      alter table public.no_policies_table enable row level security;
    `
    const result = checkTableRls(fixture, 'no_policies_table')
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['select policy', 'insert policy', 'update policy', 'delete policy'])
  })

  it('a table with all four policies but NO `enable row level security` is still red', () => {
    const fixture = `
      create table if not exists public.no_rls_table (id uuid primary key, user_id uuid not null);
      create policy "own no_rls_table select" on public.no_rls_table for select to authenticated using ((select auth.uid()) = user_id);
      create policy "own no_rls_table insert" on public.no_rls_table for insert to authenticated with check ((select auth.uid()) = user_id);
      create policy "own no_rls_table update" on public.no_rls_table for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
      create policy "own no_rls_table delete" on public.no_rls_table for delete to authenticated using ((select auth.uid()) = user_id);
    `
    const result = checkTableRls(fixture, 'no_rls_table')
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['enable row level security'])
  })

  it('the looped format()-templated idiom (resume_claims.sql) is recognized, not just the literal one', () => {
    const fixture = `
      create table if not exists public.looped_table (id uuid primary key, user_id uuid not null);
      alter table public.looped_table enable row level security;
      do $$
      declare t text;
      begin
        foreach t in array array['looped_table', 'looped_table_two']
        loop
          execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', format('own %s select', t), t);
          execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', format('own %s insert', t), t);
          execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', format('own %s update', t), t);
          execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', format('own %s delete', t), t);
        end loop;
      end
      $$;
    `
    expect(checkTableRls(fixture, 'looped_table')).toEqual({ ok: true, missing: [] })
  })

  it('a present policy that grants `to public using (true)` (world-readable, not just missing) is red on every op — literal idiom', () => {
    const fixture = `
      create table if not exists public.evil_table (id uuid primary key, user_id uuid not null);
      alter table public.evil_table enable row level security;
      create policy "own evil_table select" on public.evil_table for select to public using (true);
      create policy "own evil_table insert" on public.evil_table for insert to public with check (true);
      create policy "own evil_table update" on public.evil_table for update to public using (true) with check (true);
      create policy "own evil_table delete" on public.evil_table for delete to public using (true);
    `
    const result = checkTableRls(fixture, 'evil_table')
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['select policy', 'insert policy', 'update policy', 'delete policy'])
  })

  it('a present policy that grants `to public using (true)` is red on every op — looped idiom', () => {
    const fixture = `
      create table if not exists public.evil_looped_table (id uuid primary key, user_id uuid not null);
      alter table public.evil_looped_table enable row level security;
      do $$
      declare t text;
      begin
        foreach t in array array['evil_looped_table']
        loop
          execute format('create policy %I on public.%I for select to public using (true)', format('own %s select', t), t);
          execute format('create policy %I on public.%I for insert to public with check (true)', format('own %s insert', t), t);
          execute format('create policy %I on public.%I for update to public using (true) with check (true)', format('own %s update', t), t);
          execute format('create policy %I on public.%I for delete to public using (true)', format('own %s delete', t), t);
        end loop;
      end
      $$;
    `
    const result = checkTableRls(fixture, 'evil_looped_table')
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['select policy', 'insert policy', 'update policy', 'delete policy'])
  })

  it('the real trace_spans migration passes under the select-only shape (sanity baseline)', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, '20260818000001_trace_spans.sql'), 'utf8')
    expect(checkTableRls(sql, 'trace_spans')).toEqual({ ok: true, missing: [] })
  })

  it("stripping trace_spans' select policy's `create policy` line flips the check to red", () => {
    const realSql = readFileSync(path.join(MIGRATIONS_DIR, '20260818000001_trace_spans.sql'), 'utf8')
    const mutated = realSql.replace(
      'create policy "own trace_spans select"',
      '-- create policy "own trace_spans select" (removed by mutation test)'
    )
    const result = checkTableRls(mutated, 'trace_spans')
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('select policy')
  })

  it('a table absent from the looped array is red, even if the loop covers a sibling table', () => {
    const fixture = `
      create table if not exists public.not_in_loop (id uuid primary key, user_id uuid not null);
      alter table public.not_in_loop enable row level security;
      do $$
      declare t text;
      begin
        foreach t in array array['some_other_table']
        loop
          execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', format('own %s select', t), t);
          execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', format('own %s insert', t), t);
          execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', format('own %s update', t), t);
          execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', format('own %s delete', t), t);
        end loop;
      end
      $$;
    `
    const result = checkTableRls(fixture, 'not_in_loop')
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['select policy', 'insert policy', 'update policy', 'delete policy'])
  })
})
