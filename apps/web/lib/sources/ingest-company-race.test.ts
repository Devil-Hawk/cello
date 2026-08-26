// Regression for the company-identity blocker: ingestLeads' create-if-absent
// path (step 2) used to be a plain check-then-insert — two concurrent
// ingestLeads calls for the same user could both see "no match" from
// resolveCompany and both insert, producing two live companies for one real
// employer. The fix is DB-level (idx_companies_user_name_key_unique, migration
// 20260816000002) plus an upsert(ignoreDuplicates) here. This fake models the
// exact interleaving: by the time OUR upsert runs, a concurrent request has
// already committed the row, so ours is silently skipped (ignoreDuplicates)
// and must be re-resolved instead of dropping the lead.

import { describe, expect, it } from 'vitest'
import { ingestLeads } from './index'
import { normalizeCompanyName } from '../entities/companies'
import type { AdminClient } from '../harness/types'
import type { JobLead } from './types'

const USER_ID = 'user-race-1'
const WINNER_ID = 'company-race-winner'

type Row = Record<string, unknown>

/** Filtered query builder over a mutable array — same `.or()` two-dot-split
 *  idiom as lib/entities/companies.test.ts's fake, just reused here because
 *  this file needs its own mutable `companies` array to model the race. */
function query(rows: () => Row[], mode: 'select' | 'update', patch?: Row) {
  const filters: ((r: Row) => boolean)[] = []
  let limitN: number | null = null
  const matches = () => rows().filter((r) => filters.every((f) => f(r)))
  const builder: Record<string, unknown> = {
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val)
      return builder
    },
    or(expr: string) {
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
    is(col: string, val: unknown) {
      filters.push((r) => (r[col] ?? null) === val)
      return builder
    },
    not(col: string, _op: string, val: unknown) {
      filters.push((r) => (r[col] ?? null) !== val)
      return builder
    },
    limit(n: number) {
      limitN = n
      return builder
    },
    maybeSingle() {
      const found = matches()
      const sliced = limitN ? found.slice(0, limitN) : found
      return Promise.resolve({ data: sliced[0] ?? null, error: null })
    },
    then(resolve: (v: { data: Row[] | null; error: null }) => void) {
      const found = matches()
      if (mode === 'update') for (const r of found) Object.assign(r, patch)
      resolve({ data: found, error: null })
    },
  }
  return builder
}

/** Companies starts empty; jobs has none. `.upsert()` on companies simulates
 *  losing a concurrent create: instead of inserting, it seeds the "winner"
 *  row (as if another request's insert committed first) and returns no
 *  data — exactly what ignoreDuplicates does on a real conflict. */
function fakeAdmin(): AdminClient {
  const companies: Row[] = []

  const admin = {
    from(table: string) {
      if (table === 'companies') {
        return {
          select: () => query(() => companies, 'select'),
          upsert: () => ({
            select: () => {
              companies.push({
                id: WINNER_ID,
                name: 'Race Co',
                domain: null,
                name_key: normalizeCompanyName('Race Co'),
                canonical_id: null,
                user_id: USER_ID,
              })
              return Promise.resolve({ data: [], error: null })
            },
          }),
        }
      }
      if (table === 'company_merge_candidates') {
        return { select: () => query(() => [], 'select') }
      }
      if (table === 'jobs') {
        return {
          select() {
            const builder = {
              eq: () => builder,
              then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: [], error: null }),
            }
            return builder
          },
          upsert() {
            return { select: () => ({ then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: [{ id: 'race-job-1' }], error: null }) }) }
          },
        }
      }
      throw new Error(`fakeAdmin: unexpected table "${table}"`)
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  }
  return admin as unknown as AdminClient
}

const LEAD: JobLead = {
  company: 'Race Co',
  title: 'Engineer',
  url: 'https://example.com/jobs/race-co-engineer',
  location: 'Remote',
  salary: null,
  description: 'Ship the thing.',
  source: 'arbeitnow',
  externalId: 'arbeitnow-race-1',
  companyDomain: null,
  postedAt: null,
}

describe('ingestLeads — a lost create-if-absent race re-resolves onto the winner', () => {
  it('attaches the job to the concurrently-created company instead of erroring or dropping it', async () => {
    const admin = fakeAdmin()

    const result = await ingestLeads(admin, USER_ID, [LEAD])

    expect(result.errors).toEqual([])
    // No company reported as created by US — the other request won the race.
    expect(result.createdCompanies).toBe(0)
    // The lead still landed, attached to the winner's company via re-resolve.
    expect(result.inserted).toBe(1)
    expect(result.jobIds).toEqual(['race-job-1'])
  })
})
