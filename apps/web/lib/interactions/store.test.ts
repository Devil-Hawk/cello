// Tests for lib/interactions/store.ts — the STEP 5 projection chokepoint.
// Central claims under test: recordInteraction upserts on (ref_table,
// ref_id, kind) so a duplicate call updates in place rather than
// duplicating the row; it resolves company_id through the merge-aware
// resolveCompanyId chokepoint before writing; timelineFor's query shape
// filters correctly per scope. Zero network, zero real database — same
// fake-PostgREST-chain style as lib/entities/companies.test.ts.

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordInteraction, timelineFor } from './store'

type Row = Record<string, unknown>

function makeFakeDb(tables: { interactions: Row[]; companies: Row[] }) {
  function from(table: string) {
    const rows = tables[table as keyof typeof tables]
    if (!rows) throw new Error(`makeFakeDb: unexpected table "${table}"`)

    return {
      select(_cols?: string) {
        const filters: ((r: Row) => boolean)[] = []
        let order: { col: string; ascending: boolean } | null = null
        let limitN: number | null = null
        const builder = {
          eq(col: string, val: unknown) {
            filters.push((r) => r[col] === val)
            return builder
          },
          order(col: string, opts?: { ascending?: boolean }) {
            order = { col, ascending: opts?.ascending ?? true }
            return builder
          },
          limit(n: number) {
            limitN = n
            return builder
          },
          async maybeSingle() {
            const found = rows.filter((r) => filters.every((f) => f(r)))
            return { data: found[0] ?? null, error: null }
          },
          async single() {
            const found = rows.filter((r) => filters.every((f) => f(r)))
            return { data: found[0] ?? null, error: null }
          },
          then(resolve: (v: { data: Row[]; error: null }) => void) {
            let found = rows.filter((r) => filters.every((f) => f(r)))
            if (order) {
              const { col, ascending } = order
              found = [...found].sort((a, b) => {
                const av = String(a[col]), bv = String(b[col])
                return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
              })
            }
            if (limitN) found = found.slice(0, limitN)
            resolve({ data: found, error: null })
          },
        }
        return builder
      },
      upsert(row: Row, opts?: { onConflict?: string }) {
        const conflictCols = opts?.onConflict?.split(',') ?? []
        const existing = conflictCols.length ? rows.find((r) => conflictCols.every((c) => r[c] === row[c])) : undefined
        const saved = existing ? Object.assign(existing, row) : { id: `gen-${rows.length}`, ...row }
        if (!existing) rows.push(saved)
        return {
          select: () => ({
            single: async () => ({ data: saved, error: null }),
          }),
        }
      },
    }
  }
  return { from } as unknown as SupabaseClient
}

const USER = 'user-1'

describe('recordInteraction', () => {
  it('upserts on (ref_table, ref_id, kind) — a second call updates, never duplicates', async () => {
    const db = makeFakeDb({ interactions: [], companies: [] })
    const args = {
      userId: USER,
      companyId: null,
      kind: 'outreach_sent' as const,
      occurredAt: '2026-08-01T00:00:00Z',
      title: 'first',
      refTable: 'outreach_messages',
      refId: 'msg-1',
    }
    await recordInteraction(db, args)
    await recordInteraction(db, { ...args, title: 'updated' })

    const rows = await timelineFor(db, USER, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('updated')
  })

  it('resolves company_id through the merge-aware chokepoint before writing', async () => {
    const db = makeFakeDb({
      interactions: [],
      companies: [{ id: 'dup', canonical_id: 'survivor' }],
    })
    const row = await recordInteraction(db, {
      userId: USER,
      companyId: 'dup',
      kind: 'stage_change',
      occurredAt: '2026-08-01T00:00:00Z',
      refTable: 'activities',
      refId: 'act-1',
    })
    expect(row?.company_id).toBe('survivor')
  })

  it('logs and returns null on a write failure instead of throwing', async () => {
    const db = {
      from: () => ({
        upsert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { message: 'boom' } }),
          }),
        }),
      }),
    } as unknown as SupabaseClient
    const result = await recordInteraction(db, {
      userId: USER,
      kind: 'note',
      occurredAt: '2026-08-01T00:00:00Z',
      refTable: 'x',
      refId: 'y',
    })
    expect(result).toBeNull()
  })
})

describe('timelineFor', () => {
  const fixture: Row[] = [
    { id: '1', user_id: USER, company_id: 'co-1', contact_id: null, kind: 'outreach_sent', occurred_at: '2026-08-03T00:00:00Z' },
    { id: '2', user_id: USER, company_id: 'co-1', contact_id: null, kind: 'stage_change', occurred_at: '2026-08-01T00:00:00Z' },
    { id: '3', user_id: USER, company_id: 'co-2', contact_id: 'ct-1', kind: 'note', occurred_at: '2026-08-02T00:00:00Z' },
    { id: '4', user_id: 'other-user', company_id: 'co-1', contact_id: null, kind: 'note', occurred_at: '2026-08-04T00:00:00Z' },
  ]

  it('scopes to one company, newest first, and never leaks another user', async () => {
    const db = makeFakeDb({ interactions: [...fixture], companies: [] })
    const rows = await timelineFor(db, USER, { companyId: 'co-1' })
    expect(rows.map((r) => r.id)).toEqual(['1', '2'])
  })

  it('scopes to one contact', async () => {
    const db = makeFakeDb({ interactions: [...fixture], companies: [] })
    const rows = await timelineFor(db, USER, { contactId: 'ct-1' })
    expect(rows.map((r) => r.id)).toEqual(['3'])
  })
})
