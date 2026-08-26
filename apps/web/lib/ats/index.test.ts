import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshCompany, type AtsStore, type CompanyInput, type JobUpsertRow } from './index'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Minimal in-memory AtsStore that records what refreshCompany writes. */
function makeStore(existing: string[] = []) {
  const upserted: JobUpsertRow[] = []
  const backfilled: { company_id: string; external_id: string; description: string }[] = []
  const store: AtsStore = {
    async listJobExternalIds() {
      return new Set(existing)
    },
    async upsertJobs(rows) {
      upserted.push(...rows)
    },
    async backfillJobDescriptions(rows) {
      backfilled.push(...rows)
      return rows.length
    },
    async saveCompanyMetadata() {},
    async updateCompanyLastScraped() {},
  }
  return { store, upserted, backfilled }
}

const COMPANY: CompanyInput = {
  id: 'company-1',
  name: 'Acme',
  domain: 'acme.com',
  career_url: 'https://boards.greenhouse.io/acme',
  metadata: { ats: { provider: 'greenhouse', token: 'acme' } },
}

// A Greenhouse posting whose body arrived already mis-decoded: the UTF-8 en
// dash E2 80 93 read as Latin-1 ("â\u0080\u0093") and the middle dot
// C2 B7 read as "Â·". Aggregators serve exactly this (verified live
// against remoteok.com/api) and a board is free to as well — see
// lib/jobs/mojibake.ts.
const MOJIBAKE_JOB = {
  absolute_url: 'https://acme.com/jobs/1',
  title: 'Senior Engineer â\u0080\u0093 Platform',
  location: { name: 'ZÃ¼rich' },
  first_published: '2026-07-01T00:00:00Z',
  content:
    '&lt;p&gt;Working Hours: 9:00 AM â\u0080\u0093 6:00 PMÂ Local Time&lt;/p&gt;' +
    '&lt;p&gt;Â· Design, build. 1â\u0080\u00933 years of experience with the companyâ\u0080\u0099s stack.&lt;/p&gt;',
}

const CLEAN_JOB = {
  absolute_url: 'https://acme.com/jobs/2',
  title: 'Staff Engineer – Platform',
  location: { name: 'Zürich' },
  first_published: '2026-07-01T00:00:00Z',
  content: '&lt;p&gt;Working Hours: 9:00 AM – 6:00 PM · 1–3 years of experience.&lt;/p&gt;',
}

describe('refreshCompany — mojibake repair on write', () => {
  it('repairs mis-decoded description/title/location before the row is stored', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ jobs: [MOJIBAKE_JOB] })) as unknown as typeof fetch
    const { store, upserted } = makeStore()

    const result = await refreshCompany(store, COMPANY)

    expect(result.errors).toEqual([])
    expect(upserted).toHaveLength(1)
    const row = upserted[0]
    expect(row.title).toBe('Senior Engineer – Platform')
    expect(row.location).toBe('Zürich')
    expect(row.description).toContain('9:00 AM – 6:00 PM')
    expect(row.description).toContain('· Design, build')
    expect(row.description).toContain('1–3 years')
    expect(row.description).toContain('the company’s stack')
    // Nothing of the corruption survives, and nothing became U+FFFD.
    expect(row.description).not.toContain('Â')
    expect(row.description).not.toContain('\u0080')
    expect(row.description).not.toContain('�')
  })

  it('leaves a correctly-encoded posting byte-for-byte alone', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ jobs: [CLEAN_JOB] })) as unknown as typeof fetch
    const { store, upserted } = makeStore()

    await refreshCompany(store, COMPANY)

    expect(upserted).toHaveLength(1)
    expect(upserted[0].title).toBe('Staff Engineer – Platform')
    expect(upserted[0].location).toBe('Zürich')
    expect(upserted[0].description).toBe('Working Hours: 9:00 AM – 6:00 PM · 1–3 years of experience.')
  })

  it('repairs the description used to backfill an already-stored job too', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ jobs: [MOJIBAKE_JOB] })) as unknown as typeof fetch
    // The job is already known, so it takes the backfill path, not the insert path.
    const { store, upserted, backfilled } = makeStore(['https://acme.com/jobs/1'])

    const result = await refreshCompany(store, COMPANY)

    expect(upserted).toHaveLength(0)
    expect(result.backfilled).toBe(1)
    expect(backfilled).toHaveLength(1)
    expect(backfilled[0].description).toContain('9:00 AM – 6:00 PM')
    expect(backfilled[0].description).not.toContain('Â')
  })
})
