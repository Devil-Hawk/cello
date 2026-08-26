// Source-level guard on supabase/migrations/20260816000007_hybrid_search.sql:
// SECURITY INVOKER and the `k.user_id = p_user_id` scoping predicate must
// survive every future edit to search_kb_chunks(), because nothing else
// scopes a service-role call to one user's chunks — see that migration's own
// comment (copied VERBATIM from 20260724000002_phaseB.sql's original
// definition) for why both callers (service-role admin client, cookie-scoped
// RLS client) rely on it.
//
// This is a standalone file rather than living in a step-6 "RLS shape" test
// file because that file does not exist yet as of this step (hybrid search
// lands before the RLS-shape step in the langgraph port). Fold this into that
// file when it arrives rather than duplicating the read-the-migration
// plumbing.
//
// MUTATION-TESTED, not just written — same lesson lib/access/lockdown.test.ts
// documents at length: a check that stays green when the property it names is
// removed is worse than no check, because it also LOOKS like someone verified
// it. The two MUTATION tests below prove hasUserScoping() actually goes red
// on the two edits that matter, every time this suite runs — not just once,
// by hand, before this file was committed.
//
// Comments are stripped before either check runs: the migration's own prose
// says "SECURITY INVOKER" and "k.user_id = p_user_id" in describing what it
// preserves, and prose must never be what makes a security test pass.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260816000007_hybrid_search.sql'
)

const RAW_SQL = readFileSync(MIGRATION_PATH, 'utf8')

/** Strips `-- ...` line comments so prose can never satisfy a code check. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

const SQL = stripComments(RAW_SQL)

/**
 * True iff the (comment-stripped) SQL declares `security invoker` and the
 * `k.user_id = p_user_id` predicate appears at least twice — once scoping the
 * FTS candidate list, once scoping the vector candidate list. Two, not one:
 * a hybrid search that scopes only the FTS half would leak every user's
 * embeddings into the vector-ranked results.
 */
function hasUserScoping(sql: string): boolean {
  const hasInvoker = /security\s+invoker/i.test(sql)
  const predicateCount = (sql.match(/k\.user_id\s*=\s*p_user_id/g) ?? []).length
  return hasInvoker && predicateCount >= 2
}

describe('search_kb_chunks (hybrid) preserves its security posture', () => {
  it('is defined in the migration at all (a broken path must not pass silently)', () => {
    expect(RAW_SQL.length).toBeGreaterThan(500)
    expect(RAW_SQL).toContain('search_kb_chunks')
  })

  it('the real migration has SECURITY INVOKER and the user_id predicate on both candidate lists', () => {
    expect(hasUserScoping(SQL)).toBe(true)
  })

  it('MUTATION: goes red when the user_id predicate is stripped from a copy', () => {
    const mutated = SQL.replace(/k\.user_id\s*=\s*p_user_id/g, 'true')
    expect(mutated).not.toBe(SQL)
    expect(hasUserScoping(mutated)).toBe(false)
  })

  it('MUTATION: goes red when only the SECOND (vector-list) predicate is dropped', () => {
    // The narrower, more realistic mistake: someone copies the FTS block to
    // write the vector block and forgets the scoping line — the FTS half
    // still looks fine on its own, which is exactly what a >= 2 count (not
    // a bare "contains the string once") is defending against.
    const firstIdx = SQL.indexOf('k.user_id = p_user_id')
    const secondIdx = SQL.indexOf('k.user_id = p_user_id', firstIdx + 1)
    expect(secondIdx).toBeGreaterThan(-1)
    const mutated = SQL.slice(0, secondIdx) + 'true' + SQL.slice(secondIdx + 'k.user_id = p_user_id'.length)
    expect(mutated).not.toBe(SQL)
    expect(hasUserScoping(mutated)).toBe(false)
  })

  it('MUTATION: goes red when SECURITY INVOKER is flipped to SECURITY DEFINER', () => {
    const mutated = SQL.replace(/security\s+invoker/i, 'security definer')
    expect(mutated).not.toBe(SQL)
    expect(hasUserScoping(mutated)).toBe(false)
  })

  it('the prose mention of SECURITY INVOKER in the header comment does not, by itself, satisfy the check', () => {
    // Regression guard for the exact vacuous-pass failure mode
    // lockdown.test.ts documents: if this ever starts passing on
    // comment-only text, the check above is checking prose, not code.
    const commentOnly = RAW_SQL.split('\n').filter((line) => line.trim().startsWith('--')).join('\n')
    expect(hasUserScoping(commentOnly)).toBe(false)
  })
})
