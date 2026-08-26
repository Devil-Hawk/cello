// Tests for scripts/backfill-interactions.ts — the central claim is
// IDEMPOTENCY: running a source's backfill twice against the same fixtures
// must not duplicate interactions rows, because it routes through the same
// recordInteraction upsert every live write path uses. Zero network, zero
// real database — a small in-memory fake covering exactly the PostgREST
// chain shapes these functions and recordInteraction call.
//
// See the script's own header for why main() is guarded rather than run on
// import.

import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { backfillOutreach, backfillActivities } from './backfill-interactions'

type Row = Record<string, unknown>
type Tables = Record<string, Row[]>

/**
 * Generic in-memory fake of the PostgREST chain shapes this script and
 * lib/interactions/store.ts#recordInteraction call: select/eq/gt/in/order/
 * limit/maybeSingle/then, plus upsert keyed by onConflict columns.
 */
function makeFakeDb(tables: Tables): SupabaseClient {
  function from(table: string) {
    const rows = tables[table]
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
          gt(col: string, val: unknown) {
            filters.push((r) => String(r[col]) > String(val))
            return builder
          },
          in(col: string, vals: unknown[]) {
            filters.push((r) => vals.includes(r[col]))
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
        return { select: () => ({ single: async () => ({ data: saved, error: null }) }) }
      },
    }
  }
  return { from } as unknown as SupabaseClient
}

describe('backfillOutreach idempotency', () => {
  it('running twice on the same fixtures leaves exactly one interaction per eligible row', async () => {
    const tables: Tables = {
      outreach_messages: [
        { id: 'msg-1', user_id: 'u1', company_id: 'co-1', contact_id: 'ct-1', job_id: 'job-1', subject: 's1', kind: 'initial', to_email: 'a@b.com', status: 'sent', sent_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
        { id: 'msg-2', user_id: 'u1', company_id: 'co-1', contact_id: null, job_id: null, subject: 's2', kind: 'follow_up', to_email: 'c@d.com', status: 'sent', sent_at: '2026-08-02T00:00:00Z', updated_at: '2026-08-02T00:00:00Z' },
        { id: 'msg-3', user_id: 'u1', company_id: 'co-1', contact_id: null, job_id: null, subject: 's3', kind: 'initial', to_email: 'e@f.com', status: 'pending_review', sent_at: null, updated_at: '2026-08-02T00:00:00Z' },
      ],
      companies: [],
      interactions: [],
    }
    const db = makeFakeDb(tables)

    const first = await backfillOutreach(db, true, null)
    expect(first.eligible).toBe(2) // only the 2 'sent' rows — msg-3 is pending_review
    expect(first.written).toBe(2)
    expect(tables.interactions).toHaveLength(2)

    const second = await backfillOutreach(db, true, null)
    expect(second.eligible).toBe(2)
    // Idempotent: still exactly 2 rows, not 4 — the second pass updated in place.
    expect(tables.interactions).toHaveLength(2)
    expect(new Set(tables.interactions.map((r) => r.ref_id)).size).toBe(2)
  })
})

describe('backfillActivities idempotency and gating', () => {
  function fixture(): Tables {
    return {
      activities: [
        { id: 'act-1', application_id: 'app-1', type: 'interview_scheduled', title: 'Interview', description: null, occurred_at: '2026-08-01T00:00:00Z', metadata: { stage_decision: { action: 'no_change' } } },
        { id: 'act-2', application_id: 'app-1', type: 'stage_change', title: 'Advanced', description: null, occurred_at: '2026-08-02T00:00:00Z', metadata: { stage_decision: { action: 'advanced' } } },
        { id: 'act-3', application_id: 'app-1', type: 'email_received', title: 'FYI', description: null, occurred_at: '2026-08-03T00:00:00Z', metadata: { stage_decision: { action: 'ignored_regression' } } },
      ],
      applications: [{ id: 'app-1', user_id: 'u1', job_id: 'job-1' }],
      jobs: [{ id: 'job-1', company_id: 'co-1' }],
      companies: [],
      interactions: [],
    }
  }

  it('projects interview unconditionally and stage_change only on advance, skipping ignored/no-op rows', async () => {
    const tables = fixture()
    const db = makeFakeDb(tables)
    const first = await backfillActivities(db, true, null)
    expect(first.eligible).toBe(2) // act-1 (interview) + act-2 (advanced) — act-3 skipped
    expect(tables.interactions).toHaveLength(2)
    expect(tables.interactions.map((r) => r.kind).sort()).toEqual(['interview', 'stage_change'])
  })

  it('is idempotent across a second run on the same fixtures', async () => {
    const tables = fixture()
    const db = makeFakeDb(tables)
    await backfillActivities(db, true, null)
    await backfillActivities(db, true, null)
    expect(tables.interactions).toHaveLength(2)
  })
})
