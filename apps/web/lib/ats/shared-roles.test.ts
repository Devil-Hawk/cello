// A role is one row per posting, shared by everyone who follows its employer (migration 20261008055000).
// Rows of a company in the directory are written once per employer; a repost under a new id leaves one
// open row for the person, because the old id is no longer listed and closes.

import { describe, expect, it } from 'vitest'
import { emptyResult, syncJobs, type AtsStore, type CompanyInput, type ExistingJob, type JobUpdate, type JobUpsertRow } from './index'
import { makeSupabaseAtsStore } from './store'
import type { AtsJob } from './types'

const DIRECTORY: CompanyInput = { id: 'c1', name: 'Acme', domain: 'acme.com', career_url: 'https://acme.com/careers', user_id: 'u1', employer_id: 'e1' }
const PLAIN: CompanyInput = { id: 'c2', name: 'Acme', domain: 'acme.com', career_url: 'https://acme.com/careers', user_id: 'u1' }

const listing = (id: string, title = 'Backend Engineer'): AtsJob => ({
  title,
  url: `https://acme.com/jobs/${id}`,
  externalId: id,
  description: 'Build things.',
  postedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
})

function memory(stored: ExistingJob[] = []) {
  const upserted: JobUpsertRow[] = []
  const updated: JobUpdate[] = []
  const sightings: { ids: string[]; sources: string[] }[] = []
  const store: AtsStore = {
    async listJobs() {
      return stored
    },
    async upsertJobs(rows) {
      upserted.push(...rows)
    },
    async updateJobs(rows) {
      updated.push(...rows)
      return rows.length
    },
    async recordSightings(_company, ids, sources) {
      sightings.push({ ids, sources })
      return { seen: ids.length, reopened: 0, missed: 0, closed: 0 }
    },
    async saveCompanyMetadata() {},
    async updateCompanyLastScraped() {},
    async clearBoardJobs() {
      return { deleted: 0, closed: 0 }
    },
  }
  return { store, upserted, updated, sightings }
}

const existing = (externalId: string, title: string): ExistingJob => ({ externalId, title, location: null, salaryRange: null, descriptionMd5: 'abc', open: true })

async function sync(company: CompanyInput, listed: AtsJob[], stored: ExistingJob[] = []) {
  const m = memory(stored)
  const result = emptyResult(company)
  await syncJobs(m.store, company, listed, { source: 'greenhouse', sightingSources: ['greenhouse'], stored: new Map(stored.map((s) => [s.externalId, s])) }, result)
  return { ...m, result }
}

describe('rows of a company in the directory', () => {
  it('carry the employer, and a plain company\'s rows do not carry the key at all (a merge must not null a stored employer)', async () => {
    const shared = await sync(DIRECTORY, [listing('a')])
    expect(shared.upserted[0].employer_id).toBe('e1')
    const plain = await sync(PLAIN, [listing('a')])
    expect('employer_id' in plain.upserted[0]).toBe(false)
  })

  it('update the shared row by employer, not by the company that stored it', async () => {
    const m = await sync(DIRECTORY, [{ ...listing('a'), title: 'Backend Engineer II' }], [existing('a', 'Backend Engineer')])
    expect(m.updated).toMatchObject([{ companyId: 'c1', employerId: 'e1', externalId: 'a', fields: { title: 'Backend Engineer II' } }])
    const plain = await sync(PLAIN, [{ ...listing('a'), title: 'Backend Engineer II' }], [existing('a', 'Backend Engineer')])
    expect('employerId' in plain.updated[0]).toBe(false)
  })
})

describe('a posting reposted with a new id', () => {
  it('is stored as the new role and the old id is not sighted, so it counts a miss and closes', async () => {
    const first = await sync(DIRECTORY, [listing('old')])
    expect(first.upserted.map((r) => r.external_id)).toEqual(['old'])

    // the employer reposts the same role under a new id; the old one is no longer listed
    const second = await sync(DIRECTORY, [listing('new')], [existing('old', 'Backend Engineer')])
    expect(second.upserted.map((r) => r.external_id)).toEqual(['new'])
    expect(second.sightings).toEqual([{ ids: ['new'], sources: ['greenhouse'] }])
  })
})

describe('the store', () => {
  /** A client that records the calls the store makes. */
  function client(rpcError: { code: string } | null = null) {
    const calls: { kind: string; name: string; args?: unknown }[] = []
    const builder = (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => (calls.push({ kind: 'eq', name: `${table}.${col}`, args: val }), b),
        order: () => b,
        range: () => Promise.resolve({ data: [], error: null }),
        upsert: (rows: unknown, opts: unknown) => (calls.push({ kind: 'upsert', name: table, args: { rows, opts } }), Promise.resolve({ error: null })),
      }
      return b
    }
    return {
      calls,
      db: {
        from: builder,
        rpc: async (name: string, args: unknown) => (calls.push({ kind: 'rpc', name, args }), { data: null, error: rpcError }),
      } as never,
    }
  }
  const row = (employer?: string): JobUpsertRow => ({ company_id: 'c1', ...(employer ? { employer_id: employer } : {}), external_id: 'a' }) as unknown as JobUpsertRow

  it('lists the employer\'s roles when the company has one, and the company\'s otherwise', async () => {
    const { db, calls } = client()
    await makeSupabaseAtsStore(db).listJobs('c1', 'e1')
    await makeSupabaseAtsStore(db).listJobs('c1', null)
    expect(calls.filter((c) => c.kind === 'eq')).toEqual([
      { kind: 'eq', name: 'jobs.employer_id', args: 'e1' },
      { kind: 'eq', name: 'jobs.company_id', args: 'c1' },
    ])
  })

  it('writes an employer\'s rows through upsert_shared_jobs and the rest by company and external id', async () => {
    const { db, calls } = client()
    await makeSupabaseAtsStore(db).upsertJobs([row('e1'), row()])
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['rpc:upsert_shared_jobs', 'upsert:jobs'])
    expect((calls[0].args as { p_rows: unknown[] }).p_rows).toHaveLength(1)
    expect((calls[1].args as { opts: unknown }).opts).toMatchObject({ onConflict: 'company_id,external_id' })
  })

  it('writes through the service client when one is given, never the signed-in one', async () => {
    const person = client()
    const service = client()
    await makeSupabaseAtsStore(person.db, { lockClient: service.db }).upsertJobs([row('e1')])
    expect(person.calls).toEqual([])
    expect(service.calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['rpc:upsert_shared_jobs'])
  })

  it('falls back to the company\'s own row before the function exists, and fails on any other error', async () => {
    const before = client({ code: 'PGRST202' })
    await makeSupabaseAtsStore(before.db).upsertJobs([row('e1')])
    expect(before.calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['rpc:upsert_shared_jobs', 'upsert:jobs'])

    const broken = client()
    ;(broken.db as { rpc: unknown }).rpc = async () => ({ data: null, error: { code: '42501', message: 'denied' } })
    await expect(makeSupabaseAtsStore(broken.db).upsertJobs([row('e1')])).rejects.toThrow('denied')
  })
})
