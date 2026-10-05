import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  providers,
  refreshCompany,
  type AtsStore,
  type CompanyInput,
  type ExistingJob,
  type JobUpdate,
  type JobUpsertRow,
} from './index'

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
function makeStore(existing: ExistingJob[] = [], opts: { sightings?: boolean; lock?: boolean | 'busy' } = {}) {
  const upserted: JobUpsertRow[] = []
  const updated: JobUpdate[] = []
  const sightings: { companyId: string; ids: string[]; sources: string[] }[] = []
  const locks: string[] = []
  const store: AtsStore = {
    async listJobs() {
      return existing
    },
    async upsertJobs(rows) {
      upserted.push(...rows)
    },
    async updateJobs(rows) {
      updated.push(...rows)
      return rows.length
    },
    ...(opts.sightings
      ? {
          async recordSightings(companyId: string, ids: string[], sources: string[]) {
            sightings.push({ companyId, ids, sources })
            return { seen: ids.length, reopened: 0, missed: 0, closed: 1 }
          },
        }
      : {}),
    ...(opts.lock
      ? {
          async acquireCompanyLock(id: string) {
            locks.push(`acquire:${id}`)
            return opts.lock !== 'busy'
          },
          async releaseCompanyLock(id: string) {
            locks.push(`release:${id}`)
          },
        }
      : {}),
    async saveCompanyMetadata() {},
    async updateCompanyLastScraped() {},
  }
  return { store, upserted, updated, sightings, locks }
}

function stored(externalId: string, over: Partial<ExistingJob> = {}): ExistingJob {
  return { externalId, title: 'Old title', location: null, salaryRange: null, descriptionMd5: null, ...over }
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
    '&lt;p&gt;Working Hours: 9:00 AM â\u0080\u0093 6:00 PMÂ Local Time&lt;/p&gt;' +
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

  it('repairs the description used to update an already-stored job too', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ jobs: [MOJIBAKE_JOB] })) as unknown as typeof fetch
    // The job is already known (with no description), so it takes the update path, not the insert path.
    const { store, upserted, updated } = makeStore([stored('https://acme.com/jobs/1')])

    const result = await refreshCompany(store, COMPANY)

    expect(upserted).toHaveLength(0)
    expect(result.updated).toBe(1)
    expect(updated).toHaveLength(1)
    expect(updated[0].fields.description).toContain('9:00 AM – 6:00 PM')
    expect(updated[0].fields.description).not.toContain('Â')
  })
})

const BODY =
  '&lt;h3&gt;Minimum requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;5+ years of experience&lt;/li&gt;&lt;li&gt;Python and SQL&lt;/li&gt;&lt;/ul&gt;'
const JOB_A = { absolute_url: 'https://acme.com/jobs/a', title: 'Data Engineer', location: { name: 'Remote' }, content: BODY }
const JOB_B = { absolute_url: 'https://acme.com/jobs/b', title: 'Backend Engineer', location: { name: 'Berlin' }, content: BODY }

function listJobs(...jobs: object[]) {
  globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ jobs })) as unknown as typeof fetch
}

describe('refreshCompany: new rows carry the full description and what it asks for', () => {
  it('stores the description, the requirements read from it and a last-seen stamp', async () => {
    listJobs(JOB_A)
    const { store, upserted } = makeStore()
    await refreshCompany(store, COMPANY)
    expect(upserted).toHaveLength(1)
    const row = upserted[0]
    expect(row.description).toContain('Python and SQL')
    expect(row.requirements.must_have).toEqual(expect.arrayContaining(['Python', 'SQL']))
    expect(row.requirements.years_experience.min).toBe(5)
    expect(row.requirements_extracted_at).toBe(row.last_seen_at)
    expect(row.source).toBe('greenhouse')
  })
})

describe('refreshCompany: stored jobs', () => {
  it('writes only what changed and leaves match data and discovery date alone', async () => {
    listJobs(JOB_A, JOB_B)
    const { store, upserted, updated } = makeStore([
      stored('https://acme.com/jobs/a', { title: 'Data Engineer', location: 'Remote', descriptionMd5: 'stale' }),
      stored('https://acme.com/jobs/b', { title: 'Backend Engineer', location: 'Berlin', descriptionMd5: null }),
    ])
    const result = await refreshCompany(store, COMPANY)
    expect(upserted).toHaveLength(0)
    expect(result.updated).toBe(2)
    for (const u of updated) {
      expect(Object.keys(u.fields).sort()).toEqual(['description', 'requirements', 'requirements_extracted_at'])
    }
  })

  it('writes nothing when the source text is unchanged', async () => {
    listJobs(JOB_A)
    const first = makeStore()
    await refreshCompany(first.store, COMPANY)
    const md5 = createHash('md5').update(first.upserted[0].description).digest('hex')

    listJobs(JOB_A)
    const { store, updated } = makeStore([
      stored('https://acme.com/jobs/a', { title: 'Data Engineer', location: 'Remote', descriptionMd5: md5 }),
    ])
    const result = await refreshCompany(store, COMPANY)
    expect(updated).toEqual([])
    expect(result.updated).toBe(0)
  })

  it('does not blank a stored location or description when the source omits them', async () => {
    listJobs({ absolute_url: 'https://acme.com/jobs/a', title: 'Data Engineer' })
    const { store, updated } = makeStore([
      stored('https://acme.com/jobs/a', { title: 'Data Engineer', location: 'Remote', descriptionMd5: 'x' }),
    ])
    await refreshCompany(store, COMPANY)
    expect(updated).toEqual([])
  })

  it('tells the provider which stored jobs already have a description', async () => {
    const seen: Array<(id: string) => boolean> = []
    const spy = vi.spyOn(providers.greenhouse, 'fetch').mockImplementation(async (_t, ctx) => {
      if (ctx?.hasDescription) seen.push(ctx.hasDescription)
      return []
    })
    const { store } = makeStore([stored('https://acme.com/jobs/a', { descriptionMd5: 'x' }), stored('https://acme.com/jobs/b')])
    await refreshCompany(store, COMPANY)
    expect(spy).toHaveBeenCalled()
    expect(seen[0]('https://acme.com/jobs/a')).toBe(true)
    expect(seen[0]('https://acme.com/jobs/b')).toBe(false)
    expect(seen[0]('https://acme.com/jobs/new')).toBe(false)
  })
})

describe('refreshCompany: what was listed', () => {
  it('records every listed id against the provider and the page reader, and reports what closed', async () => {
    listJobs(JOB_A, JOB_B)
    const { store, sightings } = makeStore([], { sightings: true })
    const result = await refreshCompany(store, COMPANY)
    expect(sightings).toEqual([
      {
        companyId: 'company-1',
        ids: ['https://acme.com/jobs/a', 'https://acme.com/jobs/b'],
        sources: ['greenhouse', 'scraper'],
      },
    ])
    expect(result.closed).toBe(1)
  })

  it('records a sighting even for a posting the classifier would not store', async () => {
    listJobs(JOB_A, { absolute_url: 'https://acme.com/jobs/nav', title: 'Learn More' })
    const { store, sightings } = makeStore([], { sightings: true })
    await refreshCompany(store, COMPANY)
    expect(sightings[0].ids).toContain('https://acme.com/jobs/nav')
  })

  it('an empty board records nothing, so a board that failed to load closes nothing', async () => {
    listJobs()
    const { store, sightings } = makeStore([stored('https://acme.com/jobs/a')], { sightings: true })
    const result = await refreshCompany(store, COMPANY)
    expect(sightings).toEqual([])
    expect(result.found).toBe(0)
    expect(result.closed).toBe(0)
  })

  it('a failed fetch records nothing', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    const { store, sightings } = makeStore([stored('https://acme.com/jobs/a')], { sightings: true })
    const result = await refreshCompany(store, COMPANY)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(sightings).toEqual([])
    expect(result.closed).toBe(0)
  })

  it('a provider that returns a capped window stamps sightings but never counts a miss', async () => {
    const ids = Array.from({ length: 3 }, (_, i) => `https://acme.com/jobs/${i}`)
    const original = providers.workday.maxJobs
    providers.workday.maxJobs = 3
    try {
      vi.spyOn(providers.workday, 'fetch').mockResolvedValue(ids.map((url) => ({ title: 'Engineer', url, externalId: url })))
      const { store, sightings } = makeStore([], { sightings: true })
      await refreshCompany(store, { ...COMPANY, metadata: { ats: { provider: 'workday', token: 'acme.wd5.Careers' } } })
      expect(sightings[0].sources).toEqual([])
      expect(sightings[0].ids).toEqual(ids)
    } finally {
      providers.workday.maxJobs = original
    }
  })
})

describe('refreshCompany: one refresh of a company at a time', () => {
  it('holds the lock for the whole refresh and releases it', async () => {
    listJobs(JOB_A)
    const { store, locks, upserted } = makeStore([], { lock: true })
    await refreshCompany(store, COMPANY)
    expect(locks).toEqual(['acquire:company-1', 'release:company-1'])
    expect(upserted).toHaveLength(1)
  })

  it('does nothing and does not fetch when someone else holds it', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { store, locks, upserted } = makeStore([], { lock: 'busy' })
    const result = await refreshCompany(store, COMPANY)
    expect(result.busy).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(upserted).toEqual([])
    expect(locks).toEqual(['acquire:company-1'])
  })

  it('releases the lock when the refresh fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    const { store, locks } = makeStore([], { lock: true })
    await refreshCompany(store, COMPANY)
    expect(locks).toEqual(['acquire:company-1', 'release:company-1'])
  })
})
