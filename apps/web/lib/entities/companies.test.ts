// lib/entities/companies.ts — the company-identity chokepoint. Exercises
// resolveCompany's exact/canonical/no-match paths, mergeCompanies' one-hop
// chain collapse (the invariant resolveCompanyId depends on), scanMergeCandidates'
// same-domain auto-merge vs. trgm-fuzzy human-review split, idempotency, and
// unmerge. Zero network, zero real database — a small in-memory fake standing
// in for the exact PostgREST chain shapes this module calls.

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  mergeCompanies,
  resolveCompany,
  resolveCompanyId,
  scanMergeCandidates,
  unmergeCompany,
} from './companies'

type Row = Record<string, unknown>

/**
 * In-memory fake of exactly the PostgREST chain shapes companies.ts calls:
 * select/update/insert with eq/or/is/not/limit/maybeSingle, plus `.rpc()` for
 * find_company_merge_candidates. Not a general Supabase mock. `.or()` parses
 * PostgREST's `col.eq.value` syntax by the first two dots only, so a value
 * that itself contains a dot (a domain) still parses correctly.
 */
function makeFakeDb(tables: { companies: Row[]; company_merge_candidates: Row[] }, rpcImpl?: (args: unknown) => Row[]) {
  function query(rows: Row[], mode: 'select' | 'update', patch?: Row) {
    const filters: ((r: Row) => boolean)[] = []
    let limitN: number | null = null

    const matches = () => rows.filter((r) => filters.every((f) => f(r)))

    const builder: {
      eq: (col: string, val: unknown) => typeof builder
      or: (expr: string) => typeof builder
      is: (col: string, val: unknown) => typeof builder
      not: (col: string, op: string, val: unknown) => typeof builder
      limit: (n: number) => typeof builder
      maybeSingle: () => Promise<{ data: Row | null; error: null }>
      then: (resolve: (v: { data: Row[] | null; error: null }) => void) => void
    } = {
      eq(col, val) {
        filters.push((r) => r[col] === val)
        return builder
      },
      or(expr) {
        const clauses = expr.split(',').map((c) => {
          const i1 = c.indexOf('.')
          const i2 = c.indexOf('.', i1 + 1)
          const col = c.slice(0, i1)
          const val = c.slice(i2 + 1)
          return (r: Row) => r[col] === val
        })
        filters.push((r) => clauses.some((c) => c(r)))
        return builder
      },
      is(col, val) {
        filters.push((r) => r[col] === val)
        return builder
      },
      not(col, _op, val) {
        filters.push((r) => r[col] !== val)
        return builder
      },
      limit(n) {
        limitN = n
        return builder
      },
      maybeSingle() {
        const found = matches()
        const sliced = limitN ? found.slice(0, limitN) : found
        if (mode === 'update') {
          for (const r of found) Object.assign(r, patch)
          return Promise.resolve({ data: null, error: null })
        }
        return Promise.resolve({ data: sliced[0] ?? null, error: null })
      },
      then(resolve) {
        const found = matches()
        if (mode === 'update') {
          for (const r of found) Object.assign(r, patch)
          resolve({ data: null, error: null })
        } else {
          resolve({ data: found, error: null })
        }
      },
    }
    return builder
  }

  function from(table: string) {
    const rows = tables[table as keyof typeof tables]
    if (!rows) throw new Error(`makeFakeDb: unexpected table "${table}"`)
    return {
      select: () => query(rows, 'select'),
      update: (patch: Row) => query(rows, 'update', patch),
      insert: (newRows: Row | Row[]) => {
        const arr = (Array.isArray(newRows) ? newRows : [newRows]).map((r) => ({
          id: `gen-${rows.length}-${Math.random().toString(36).slice(2)}`,
          ...r,
        }))
        rows.push(...arr)
        return Promise.resolve({ data: arr, error: null })
      },
      // Enough of PostgREST upsert to exercise mergeCompanies/scanMergeCandidates's
      // ignoreDuplicates-backed writes: a row matching every onConflict column is
      // either left untouched (ignoreDuplicates) or overwritten in place.
      upsert: (newRows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        const conflictCols = opts?.onConflict?.split(',') ?? []
        const arr = Array.isArray(newRows) ? newRows : [newRows]
        const results: Row[] = []
        for (const r of arr) {
          const existing = conflictCols.length ? rows.find((row) => conflictCols.every((c) => row[c] === r[c])) : undefined
          if (existing) {
            if (!opts?.ignoreDuplicates) Object.assign(existing, r)
            results.push(existing)
          } else {
            const created = { id: `gen-${rows.length}-${Math.random().toString(36).slice(2)}`, ...r }
            rows.push(created)
            results.push(created)
          }
        }
        return Promise.resolve({ data: results, error: null })
      },
    }
  }

  return {
    from,
    rpc: (_name: string, args: unknown) => Promise.resolve({ data: rpcImpl ? rpcImpl(args) : [], error: null }),
  } as unknown as SupabaseClient
}

const USER = 'user-1'

function company(id: string, overrides: Row = {}): Row {
  return { id, user_id: USER, name: id, name_key: id, domain: null, canonical_id: null, ...overrides }
}

describe('resolveCompany', () => {
  it('matches an exact name_key', async () => {
    const db = makeFakeDb({
      companies: [company('acme', { name: 'Acme Inc.', name_key: 'acme' })],
      company_merge_candidates: [],
    })
    const found = await resolveCompany(db, USER, { name: 'Acme Inc.' })
    expect(found).toEqual({ id: 'acme', name: 'Acme Inc.', domain: null })
  })

  it('matches an exact domain', async () => {
    const db = makeFakeDb({
      companies: [company('acme', { domain: 'acme.example.com' })],
      company_merge_candidates: [],
    })
    const found = await resolveCompany(db, USER, { domain: 'acme.example.com' })
    expect(found?.id).toBe('acme')
  })

  it('chases a matched duplicate through its canonical_id to the survivor', async () => {
    const db = makeFakeDb({
      companies: [
        company('survivor', { name: 'Acme', name_key: 'acme' }),
        company('dup', { name: 'ACME Inc', name_key: 'acme inc', canonical_id: 'survivor' }),
      ],
      company_merge_candidates: [],
    })
    // The duplicate is what actually matches this lead's exact name_key.
    const found = await resolveCompany(db, USER, { name: 'ACME Inc' })
    expect(found?.id).toBe('survivor')
  })

  it('returns null when nothing matches (caller creates)', async () => {
    const db = makeFakeDb({ companies: [], company_merge_candidates: [] })
    expect(await resolveCompany(db, USER, { name: 'Nobody Ever Heard Of This Co' })).toBeNull()
  })
})

describe('resolveCompanyId', () => {
  it('is a no-op for a survivor (canonical_id null)', async () => {
    const db = makeFakeDb({ companies: [company('a')], company_merge_candidates: [] })
    expect(await resolveCompanyId(db, 'a')).toBe('a')
  })

  it('returns the survivor for a duplicate', async () => {
    const db = makeFakeDb({
      companies: [company('a'), company('b', { canonical_id: 'a' })],
      company_merge_candidates: [],
    })
    expect(await resolveCompanyId(db, 'b')).toBe('a')
  })

  it('degrades to the input id for an unknown id (never throws)', async () => {
    const db = makeFakeDb({ companies: [], company_merge_candidates: [] })
    expect(await resolveCompanyId(db, 'ghost')).toBe('ghost')
  })
})

describe('mergeCompanies — one-hop invariant', () => {
  it('collapses a would-be chain: absorbing B repoints everything already pointing at B onto A directly', async () => {
    // C was already merged into B in an earlier scan. Now B merges into A.
    const db = makeFakeDb({
      companies: [company('a'), company('b'), company('c', { canonical_id: 'b' })],
      company_merge_candidates: [],
    })

    await mergeCompanies(db, USER, 'a', 'b')

    const rows = await db.from('companies').select('*')
    const byId = new Map(((rows as unknown as { data: Row[] }).data ?? []).map((r) => [r.id, r]))
    expect(byId.get('b')?.canonical_id).toBe('a')
    // The collapse: C never ends up pointing at B (which is now itself a
    // duplicate) — resolveCompanyId's one-hop assumption stays true.
    expect(byId.get('c')?.canonical_id).toBe('a')
  })

  it('writes a merged audit-trail row when none existed (a direct/auto-merge call)', async () => {
    const db = makeFakeDb({
      companies: [company('a'), company('b')],
      company_merge_candidates: [],
    })
    await mergeCompanies(db, USER, 'a', 'b')
    const { data } = (await db.from('company_merge_candidates').select('*')) as unknown as { data: Row[] }
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ status: 'merged', company_a: 'a', company_b: 'b' })
  })

  it('flips an existing pending row to merged instead of inserting a second row', async () => {
    const db = makeFakeDb({
      companies: [company('a'), company('b')],
      company_merge_candidates: [{ id: 'cand-1', user_id: USER, company_a: 'a', company_b: 'b', score: 0.7, reason: 'name similarity 0.70', status: 'pending' }],
    })
    await mergeCompanies(db, USER, 'a', 'b')
    const { data } = (await db.from('company_merge_candidates').select('*')) as unknown as { data: Row[] }
    expect(data).toHaveLength(1)
    expect(data[0].status).toBe('merged')
  })

  it('calling mergeCompanies twice for the same pair converges on one row instead of throwing or duplicating', async () => {
    // Models the outcome of the race idx_merge_candidates_pair_unique now
    // closes: two overlapping mergeCompanies calls for the same pair both
    // reach the audit-trail write. Neither may crash (the old code's
    // .maybeSingle() would, once a duplicate row existed) and there must
    // still be exactly one row.
    const db = makeFakeDb({ companies: [company('a'), company('b')], company_merge_candidates: [] })
    await mergeCompanies(db, USER, 'a', 'b')
    await mergeCompanies(db, USER, 'a', 'b')
    const { data } = (await db.from('company_merge_candidates').select('*')) as unknown as { data: Row[] }
    expect(data).toHaveLength(1)
    expect(data[0].status).toBe('merged')
  })

  it('rejects merging a company into itself', async () => {
    const db = makeFakeDb({ companies: [company('a')], company_merge_candidates: [] })
    await expect(mergeCompanies(db, USER, 'a', 'a')).rejects.toThrow()
  })
})

describe('unmergeCompany', () => {
  it('clears canonical_id back to null', async () => {
    const db = makeFakeDb({
      companies: [company('a'), company('b', { canonical_id: 'a' })],
      company_merge_candidates: [],
    })
    await unmergeCompany(db, USER, 'b')
    const { data } = (await db.from('companies').select('*')) as unknown as { data: Row[] }
    expect(data.find((r) => r.id === 'b')?.canonical_id).toBeNull()
  })
})

describe('scanMergeCandidates', () => {
  it('auto-merges a same-domain pair and records the audit trail', async () => {
    const db = makeFakeDb({
      companies: [
        company('a', { domain: 'acme.example.com' }),
        company('b', { name: 'ACME', name_key: 'acme', domain: 'acme.example.com' }),
      ],
      company_merge_candidates: [],
    })
    const result = await scanMergeCandidates(db, USER)
    expect(result.merged).toBe(1)

    const { data } = (await db.from('companies').select('*')) as unknown as { data: Row[] }
    const merged = data.find((r) => r.canonical_id !== null)
    expect(merged).toBeDefined()

    const { data: candidates } = (await db.from('company_merge_candidates').select('*')) as unknown as { data: Row[] }
    expect(candidates).toHaveLength(1)
    expect(candidates[0].status).toBe('merged')
  })

  it('never auto-applies a trgm-fuzzy match — it stays pending for a human', async () => {
    const db = makeFakeDb(
      { companies: [company('a', { name_key: 'acme corp' }), company('b', { name_key: 'acme corporation' })], company_merge_candidates: [] },
      () => [{ company_a: 'a', company_b: 'b', score: 0.82 }]
    )
    const result = await scanMergeCandidates(db, USER)
    expect(result.pending).toBe(1)
    expect(result.merged).toBe(0)

    const { data } = (await db.from('companies').select('*')) as unknown as { data: Row[] }
    // Neither side got a canonical_id — nothing was actually merged.
    expect(data.every((r) => r.canonical_id === null)).toBe(true)

    const { data: candidates } = (await db.from('company_merge_candidates').select('*')) as unknown as { data: Row[] }
    expect(candidates).toHaveLength(1)
    expect(candidates[0].status).toBe('pending')
  })

  it('is idempotent — a pair already recorded (any status) is never re-proposed', async () => {
    const db = makeFakeDb(
      {
        companies: [company('a', { name_key: 'acme corp' }), company('b', { name_key: 'acme corporation' })],
        company_merge_candidates: [{ id: 'cand-1', user_id: USER, company_a: 'a', company_b: 'b', score: 0.9, reason: 'rejected earlier', status: 'rejected' }],
      },
      () => [{ company_a: 'a', company_b: 'b', score: 0.82 }]
    )
    const result = await scanMergeCandidates(db, USER)
    expect(result.pending).toBe(0)
    expect(result.merged).toBe(0)

    const { data: candidates } = (await db.from('company_merge_candidates').select('*')) as unknown as { data: Row[] }
    expect(candidates).toHaveLength(1) // still just the original rejected row
    expect(candidates[0].status).toBe('rejected')
  })
})
