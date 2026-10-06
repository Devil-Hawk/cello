// What ingestLeads does with a lead for a job that is already stored:
//   - an empty stored description is filled from the lead (and never a non-empty one),
//   - last_seen_at is stamped so the prune keeps a job a source still lists,
// and a lead for a new job is stored with its requirements read.

import { describe, expect, it } from 'vitest'
import { ingestLeads } from './index'
import type { AdminClient } from '../harness/types'
import type { JobLead } from './types'

const COMPANY_ID = 'company-1'
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'

interface Update {
  fields: Record<string, unknown>
  in?: [string, unknown[]]
  eq: [string, unknown][]
}

function fakeAdmin(existing: { id: string; external_id: string; url: string; description_md5: string | null }[]) {
  const updates: Update[] = []
  const inserted: Record<string, unknown>[] = []
  const admin = {
    from(table: string) {
      if (table === 'companies') {
        return {
          select: () => {
            const b = {
              eq: () => b,
              or: () => b,
              limit: () => b,
              maybeSingle: () => Promise.resolve({ data: { id: COMPANY_ID, name: 'Real Test Co', domain: 'realtestco.example' }, error: null }),
            }
            return b
          },
        }
      }
      if (table === 'jobs' || table === 'person_jobs') {
        return {
          select() {
            const b = {
              eq: () => b,
              then(resolve: (v: { data: unknown; error: null }) => void) {
                resolve({ data: existing, error: null })
              },
            }
            return b
          },
          update(fields: Record<string, unknown>) {
            const u: Update = { fields, eq: [] }
            updates.push(u)
            const b = {
              in(col: string, values: unknown[]) {
                u.in = [col, values]
                return b
              },
              eq(col: string, value: unknown) {
                u.eq.push([col, value])
                return b
              },
              then(resolve: (v: { error: null }) => void) {
                resolve({ error: null })
              },
            }
            return b
          },
          upsert(rows: Record<string, unknown>[]) {
            inserted.push(...rows)
            return { select: () => ({ then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: rows.map((_, i) => ({ id: `new-${i}` })), error: null }) }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { admin: admin as unknown as AdminClient, updates, inserted }
}

function lead(over: Partial<JobLead> = {}): JobLead {
  return {
    company: 'Real Test Co',
    title: 'Senior Backend Engineer',
    url: 'https://example.com/jobs/1',
    location: 'Remote',
    salary: null,
    description: 'Own the payments service.\n\nRequirements\n- Go\n- SQL',
    source: 'remoteok',
    externalId: 'remoteok-1',
    companyDomain: 'realtestco.example',
    postedAt: null,
    tags: [],
    ...over,
  }
}

describe('ingestLeads: jobs that are already stored', () => {
  it('fills a stored job that has no description and leaves one that has a description alone', async () => {
    const { admin, updates } = fakeAdmin([
      { id: 'job-empty', external_id: 'remoteok-1', url: 'https://example.com/jobs/1', description_md5: EMPTY_MD5 },
      { id: 'job-full', external_id: 'remoteok-2', url: 'https://example.com/jobs/2', description_md5: 'abc123' },
    ])
    const res = await ingestLeads(admin, 'user-1', [
      lead(),
      lead({ externalId: 'remoteok-2', url: 'https://example.com/jobs/2', description: 'An aggregator copy that must not win.' }),
    ])
    expect(res.errors).toEqual([])
    const fill = updates.filter((u) => 'description' in u.fields)
    expect(fill).toHaveLength(1)
    expect(fill[0].eq).toContainEqual(['id', 'job-empty'])
    // The guard that keeps a board's text from being overwritten.
    expect(fill[0].eq).toContainEqual(['description', ''])
    expect(fill[0].fields.description).toContain('Own the payments service.')
    expect(fill[0].fields.requirements).toMatchObject({ version: 1 })
    expect(updates.some((u) => (u.eq as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(['id', 'job-full'])))).toBe(false)
  })

  it('stamps last_seen_at on every stored job the lead list names', async () => {
    const { admin, updates } = fakeAdmin([
      { id: 'job-a', external_id: 'remoteok-1', url: 'https://example.com/jobs/1', description_md5: 'x' },
      { id: 'job-b', external_id: 'remoteok-2', url: 'https://example.com/jobs/2', description_md5: 'y' },
    ])
    await ingestLeads(admin, 'user-1', [lead(), lead({ externalId: 'remoteok-2', url: 'https://example.com/jobs/2' })])
    const seen = updates.find((u) => u.in)
    expect(seen?.in?.[0]).toBe('id')
    expect([...(seen?.in?.[1] as string[])].sort()).toEqual(['job-a', 'job-b'])
    expect(typeof seen?.fields.last_seen_at).toBe('string')
    // Only the sighting: an aggregator re-listing does not reopen or rewrite anything else.
    expect(Object.keys(seen!.fields)).toEqual(['last_seen_at'])
  })

  it('stores a new job with its last_seen_at and the requirements read from its text', async () => {
    const { admin, inserted } = fakeAdmin([])
    await ingestLeads(admin, 'user-1', [lead()])
    expect(inserted).toHaveLength(1)
    expect(typeof inserted[0].last_seen_at).toBe('string')
    expect(inserted[0].requirements).toMatchObject({ version: 1, skills_resolved: true })
    expect(inserted[0].requirements_extracted_at).toBeTruthy()
  })
})
