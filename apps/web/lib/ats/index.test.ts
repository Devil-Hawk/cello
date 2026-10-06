import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../security/untrusted', async (orig) => ({
  ...(await orig<typeof import('../security/untrusted')>()),
  assertSsrfSafe: async () => {},
}))
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
  const saved: Record<string, unknown>[] = []
  const cleared: Array<[string, string]> = []
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
    async saveCompanyMetadata(_id, metadata) {
      saved.push(metadata)
    },
    async updateCompanyLastScraped() {},
    async clearBoardJobs(companyId, source) {
      cleared.push([companyId, source])
      return { deleted: 2, closed: 1 }
    },
  }
  return { store, upserted, backfilled, saved, cleared }
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

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()

describe('refreshCompany: postings older than 180 days are not stored', () => {
  it('stores and counts only the recent posting', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        jobs: [
          { ...CLEAN_JOB, absolute_url: 'https://acme.com/jobs/old', first_published: ago(200) },
          { ...CLEAN_JOB, absolute_url: 'https://acme.com/jobs/new', first_published: ago(10) },
        ],
      })
    ) as unknown as typeof fetch
    const { store, upserted } = makeStore()

    const result = await refreshCompany(store, COMPANY)

    expect(result.found).toBe(1)
    expect(upserted.map((r) => r.external_id)).toEqual(['https://acme.com/jobs/new'])
  })
})

describe('refreshCompany: a stored guessed board is re-verified', () => {
  const PERSONIO_AMAZON = readFileSync(path.join(__dirname, '__fixtures__/personio-amazon.xml'), 'utf8')
  const AMAZON: CompanyInput = {
    id: 'amazon-1',
    name: 'Amazon',
    domain: 'amazon.jobs',
    career_url: 'https://www.amazon.jobs/en/search',
    metadata: { ats: { provider: 'personio', token: 'amazon', source: 'probe' } },
  }
  const personioOnly = () =>
    vi.fn(async (url: unknown) =>
      String(url).includes('amazon.jobs.personio.de')
        ? new Response(PERSONIO_AMAZON, { status: 200 })
        : new Response('nf', { status: 404 })
    ) as unknown as typeof fetch

  it('clears the mapping and the roles that came from it, and stores nothing', async () => {
    globalThis.fetch = personioOnly()
    const { store, upserted, saved, cleared } = makeStore()

    const result = await refreshCompany(store, AMAZON)

    expect(cleared).toEqual([['amazon-1', 'personio']])
    expect(result.cleared).toEqual({ deleted: 2, closed: 1 })
    expect(upserted).toEqual([])
    expect(result.provider).toBeNull()
    expect(saved).toHaveLength(1)
    expect(saved[0]).not.toHaveProperty('ats')
    expect(saved[0].source_check).toMatchObject({ readable: false, reason: 'no_supported_board' })
  })

  it('changes nothing when the clear fails, and reports it', async () => {
    globalThis.fetch = personioOnly()
    const { store, saved } = makeStore()
    store.clearBoardJobs = async () => {
      throw new Error('function does not exist')
    }

    const result = await refreshCompany(store, AMAZON)

    expect(saved).toEqual([])
    expect(result.errors.join(' ')).toContain('function does not exist')
  })

  it('keeps a stored board that verifies and records how', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ jobs: [{ ...CLEAN_JOB, absolute_url: 'https://acme.com/jobs/9', first_published: ago(5) }] })
    ) as unknown as typeof fetch
    const { store, upserted, saved, cleared } = makeStore()

    await refreshCompany(store, {
      ...COMPANY,
      metadata: { ats: { provider: 'greenhouse', token: 'acme', source: 'probe' } },
    })

    expect(cleared).toEqual([])
    expect(upserted).toHaveLength(1)
    expect(saved[0].ats).toMatchObject({ provider: 'greenhouse', token: 'acme', verified_by: 'board_links_home' })
    expect(saved[0].source_check).toMatchObject({ readable: true })
  })

  it('does not verify a board read off the careers URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ jobs: [{ ...CLEAN_JOB, first_published: ago(5) }] })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { store, cleared } = makeStore()

    await refreshCompany(store, { ...COMPANY, metadata: { ats: { provider: 'greenhouse', token: 'acme', source: 'url' } } })

    expect(cleared).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('refreshCompany: what a check records', () => {
  it('says no careers page when there is nothing to read', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nf', { status: 404 })) as unknown as typeof fetch
    const { store, saved } = makeStore()

    await refreshCompany(store, { id: 'x', name: 'Tiny Co', domain: null, career_url: null, metadata: null })

    expect(saved[0].source_check).toMatchObject({ readable: false, reason: 'no_careers_url' })
  })
})
