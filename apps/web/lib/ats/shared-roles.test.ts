// A role is one row per posting, shared by everyone who follows its employer (migration 20261008055000).
// Rows of a company in the directory are written once per employer; a repost under a new id leaves one
// open row for the person, because the old id is no longer listed and closes.

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../security/untrusted', async (orig) => ({
  ...(await orig<typeof import('../security/untrusted')>()),
  assertSsrfSafe: async () => {},
}))
import { emptyResult, refreshCompany, syncJobs, type AtsStore, type CompanyInput, type ExistingJob, type JobUpdate, type JobUpsertRow } from './index'
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

describe('a company with no employer', () => {
  it('sends a changed role that is stored as shared to updateJobs and never upserts it', async () => {
    const m = await sync(PLAIN, [{ ...listing('a'), title: 'Backend Engineer II' }], [existing('a', 'Backend Engineer')])
    expect(m.upserted).toEqual([])
    expect(m.updated).toMatchObject([{ companyId: 'c2', externalId: 'a', fields: { title: 'Backend Engineer II' } }])
  })
})

describe('a company linked to an employer', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('is read only from its stored board: a failed read is not followed by a detection from what the person typed', async () => {
    const fetchMock = vi.fn(async () => new Response('nf', { status: 404 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { store, upserted, updated } = memory([existing('a', 'Backend Engineer')])
    const linked: CompanyInput = { ...DIRECTORY, metadata: { ats: { provider: 'greenhouse', token: 'acme', source: 'known', verified_by: 'manual' } } }

    const result = await refreshCompany(store, linked)

    expect(result.errors.join(' ')).toContain('cached greenhouse board "acme" failed')
    // only the stored board was asked: no probe of the name, the domain or the careers link
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]))
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.includes('greenhouse') && u.includes('acme'))).toBe(true)
    expect(upserted).toEqual([])
    expect(updated).toEqual([])
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

  it('updates by company only the rows that have no employer, and by employer the shared one, through the service client', async () => {
    const person = client()
    const service = client()
    const calls: string[] = []
    const update = () => {
      const b: Record<string, unknown> = {
        eq: (col: string) => (calls.push(`eq:${col}`), b),
        is: (col: string, val: unknown) => (calls.push(`is:${col}:${val}`), b),
        select: () => Promise.resolve({ data: [{ id: 'j' }], error: null }),
      }
      return b
    }
    ;(service.db as { from: unknown }).from = () => ({ update: update })
    const store = makeSupabaseAtsStore(person.db, { lockClient: service.db })
    await store.updateJobs([{ companyId: 'c1', externalId: 'a', fields: { title: 'x' } }])
    expect(calls).toEqual(['eq:company_id', 'eq:external_id', 'is:employer_id:null'])
    calls.length = 0
    await store.updateJobs([{ companyId: 'c1', employerId: 'e1', externalId: 'a', fields: { title: 'x' } }])
    expect(calls).toEqual(['eq:employer_id', 'eq:external_id'])
    expect(person.calls).toEqual([])
  })

  it('evicts and clears a company\'s roles through the service client, never the signed-in one', async () => {
    const person = client()
    const service = client()
    const store = makeSupabaseAtsStore(person.db, { lockClient: service.db })
    await store.evictJobs!('c1', ['a'])
    await store.clearBoardJobs('c1', 'greenhouse')
    expect(person.calls).toEqual([])
    expect(service.calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['rpc:evict_company_jobs', 'rpc:clear_unverified_board_jobs'])
  })

  it('records a linked company\'s sightings by employer on the service client, and an unlinked one\'s by company', async () => {
    const person = client()
    const service = client()
    const store = makeSupabaseAtsStore(person.db, { lockClient: service.db })
    await store.recordSightings!('c1', ['a'], ['greenhouse'], 'e1')
    expect(service.calls).toEqual([{ kind: 'rpc', name: 'record_employer_sightings', args: { p_employer: 'e1', p_external_ids: ['a'], p_sources: ['greenhouse'], p_close_after: 2 } }])
    expect(person.calls).toEqual([])
    await store.recordSightings!('c1', ['a'], ['greenhouse'], null)
    expect(person.calls.map((c) => c.name)).toEqual(['record_job_sightings'])
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
