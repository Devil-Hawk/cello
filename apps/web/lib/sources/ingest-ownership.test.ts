// Proves ingestLeads' existing-jobs dedup lookup scopes through the
// companies FK join (lib/harness/agents/matcher.ts's ownedJobsQuery), not an
// .in('company_id', companyIds) querystring array — the fix in the commit
// that removed the incident-causing .in() from this file (lib/sources/
// index.ts:260). Uses an in-memory fake AdminClient (no network, zero DB
// writes) that records every `.eq()` the built query actually applied, so
// this checks the query SHAPE, not just that it happens to return the right
// rows because the fixture only has one company.

import { describe, expect, it } from 'vitest'
import { ingestLeads } from './index'
import type { AdminClient } from '../harness/types'
import type { JobLead } from './types'

const USER_ID = 'user-ingest-1'
const COMPANY_ID = 'company-ingest-1'

/** Minimal in-memory fake of the PostgREST chain shapes ingestLeads uses:
 *  resolveCompany's companies lookup, the ownedJobsQuery existing-jobs lookup,
 *  and the jobs upsert. Not a general Supabase mock — just enough surface for
 *  this one code path. eqCalls records every `.eq(table, col, value)` so a
 *  test can assert the ownership filter was really built into the query. */
function fakeAdmin(): { admin: AdminClient; eqCalls: [string, string, unknown][] } {
  const eqCalls: [string, string, unknown][] = []

  const companies = [{ id: COMPANY_ID, name: 'Real Test Co', domain: 'realtestco.example' }]

  const admin = {
    from(table: string) {
      if (table === 'companies') {
        return {
          // resolveCompany's exact chain (lib/entities/companies.ts):
          // .select(...).eq('user_id', ...).or(...).limit(1).maybeSingle().
          // The fixture has exactly one company, which is the lead's — no
          // need to actually evaluate the .or() match expression.
          select: () => {
            const builder = {
              eq(col: string, value: unknown) {
                eqCalls.push([table, col, value])
                return builder
              },
              or: () => builder,
              limit: () => builder,
              maybeSingle: () => Promise.resolve({ data: companies[0] ?? null, error: null }),
            }
            return builder
          },
        }
      }
      if (table === 'jobs') {
        return {
          select() {
            const builder = {
              eq(col: string, value: unknown) {
                eqCalls.push([table, col, value])
                return builder
              },
              then(resolve: (v: { data: unknown; error: null }) => void) {
                resolve({ data: [], error: null }) // no existing jobs — forces the insert path
              },
            }
            return builder
          },
          upsert() {
            return { select: () => ({ then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: [{ id: 'new-job-1' }], error: null }) }) }
          },
        }
      }
      throw new Error(`fakeAdmin: unexpected table "${table}"`)
    },
  }
  return { admin: admin as unknown as AdminClient, eqCalls }
}

const LEAD: JobLead = {
  company: 'Real Test Co',
  title: 'Senior Backend Engineer',
  url: 'https://example.com/jobs/senior-backend-engineer',
  location: 'Remote',
  salary: null,
  description: 'Own the payments service.',
  source: 'arbeitnow',
  externalId: 'arbeitnow-1',
  companyDomain: 'realtestco.example',
  postedAt: null,
}

describe('ingestLeads — existing-jobs dedup lookup is ownership-scoped via the FK join', () => {
  it('filters the existing-jobs query by companies.user_id, not a company-id array', async () => {
    const { admin, eqCalls } = fakeAdmin()

    const result = await ingestLeads(admin, USER_ID, [LEAD])

    expect(result.errors).toEqual([])
    expect(result.inserted).toBe(1)
    // The ownership fence: ownedJobsQuery builds this exact filter — proves
    // the dedup lookup no longer relies on an .in('company_id', companyIds)
    // array (which breaks past ~600 companies), root-caused instead via the
    // FK join.
    expect(eqCalls).toContainEqual(['jobs', 'companies.user_id', USER_ID])
  })
})
