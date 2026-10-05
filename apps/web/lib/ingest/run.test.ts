import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AtsStore, ExistingJob, JobUpsertRow } from '../ats/index'
import { MODEL_LIMIT, newModelBudget, type ModelCall } from './model'
import { ingestCompany, ingestUser, isDue, type DueCompany, type RunPatch, type RunsStore } from './run'
import type { FetchPage } from './fetch-page'

const realFetch = globalThis.fetch
beforeEach(() => {
  // Every board probe misses, so a company with no cached board is a company with no board.
  globalThis.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const FILLER = 'We are a small team that cares about customers and about each other. '.repeat(4)

function ldPage(titles: string[]): string {
  const jobs = titles.map((t, i) => ({
    '@type': 'JobPosting',
    title: t,
    url: `https://acme.example/jobs/${i + 1}`,
    description: `<p>${'You will build and run things for customers. '.repeat(10)}</p>`,
  }))
  return `<html><head><script type="application/ld+json">${JSON.stringify(jobs)}</script></head><body>${FILLER}</body></html>`
}

const PLAIN_PAGE = `<html><body><p>${FILLER}</p><div><h3>Data Analyst</h3><a href="/jobs/3">Apply</a></div></body></html>`

function company(id: string, over: Partial<DueCompany> = {}): DueCompany {
  return {
    id,
    user_id: 'user-1',
    name: `Company ${id}`,
    domain: null,
    career_url: 'https://acme.example/careers',
    scrape_frequency: null,
    last_scraped_at: null,
    is_dream_company: false,
    metadata: {},
    ...over,
  }
}

function memoryStore(opts: { lock?: 'ok' | 'busy'; existing?: ExistingJob[] } = {}) {
  const calls = { upserted: [] as JobUpsertRow[], sightings: [] as { ids: string[]; sources: string[] }[], stamped: [] as string[], locks: [] as string[] }
  const store: AtsStore = {
    async listJobs() {
      return opts.existing ?? []
    },
    async upsertJobs(rows) {
      calls.upserted.push(...rows)
    },
    async updateJobs(rows) {
      return rows.length
    },
    async recordSightings(_id, ids, sources) {
      calls.sightings.push({ ids, sources })
      return { seen: ids.length, reopened: 0, missed: 0, closed: 0 }
    },
    async acquireCompanyLock(id) {
      calls.locks.push(`acquire:${id}`)
      return opts.lock !== 'busy'
    },
    async releaseCompanyLock(id) {
      calls.locks.push(`release:${id}`)
    },
    async clearBoardJobs() {
      return { deleted: 0, closed: 0 }
    },
    async saveCompanyMetadata() {},
    async updateCompanyLastScraped(id) {
      calls.stamped.push(id)
    },
  }
  return { store, calls }
}

function fetcher(html: string | Error): FetchPage {
  return vi.fn(async (url: string) => {
    if (html instanceof Error) throw html
    return { html, finalUrl: url, rendered: false }
  })
}

describe('ingestCompany', () => {
  it('reads a company that has a job board from the board and never reaches the page reader', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ jobs: [{ absolute_url: 'https://acme.example/jobs/1', title: 'Backend Engineer', content: '&lt;p&gt;Build.&lt;/p&gt;' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch
    const { store, calls } = memoryStore()
    const fetchPage = fetcher(ldPage(['Should not be read']))
    const model = vi.fn<Parameters<ModelCall>, ReturnType<ModelCall>>()
    const out = await ingestCompany(store, company('c1', { metadata: { ats: { provider: 'greenhouse', token: 'acme' } } }), { fetchPage, model })
    expect(out.reader).toBe('greenhouse')
    expect(out.failure).toBeNull()
    expect(out.result.inserted).toBe(1)
    expect(calls.upserted[0].source).toBe('greenhouse')
    expect(fetchPage).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
  })

  it('reads a company with no board from its careers page and stores it as a scraper row', async () => {
    const { store, calls } = memoryStore()
    const out = await ingestCompany(store, company('c1'), { fetchPage: fetcher(ldPage(['Backend Engineer', 'Designer'])), model: null })
    expect(out.reader).toBe('page_reader')
    expect(out.failure).toBeNull()
    expect(out.result).toMatchObject({ found: 2, inserted: 2 })
    expect(calls.upserted.every((r) => r.source === 'scraper')).toBe(true)
    expect(calls.upserted[0].description.length).toBeGreaterThan(200)
    // A complete read (structured data) may count a missing posting as gone.
    expect(calls.sightings[0].sources).toEqual(['scraper'])
  })

  it('stamps what an incomplete page read saw but counts no miss', async () => {
    const { store, calls } = memoryStore()
    const model: ModelCall = async () =>
      JSON.stringify({ page_kind: 'listing', jobs: [{ title: 'Data Analyst', link: 1 }] })
    // A page too long for the snapshot, so the list may be cut short.
    const big = `<html><body>${'<p>filler text for the page</p>'.repeat(3000)}<div><h3>Data Analyst</h3><a href="/jobs/3">Apply</a></div></body></html>`
    const out = await ingestCompany(store, company('c1'), { fetchPage: fetcher(big), model })
    expect(out.result.found).toBe(1)
    expect(calls.sightings[0].sources).toEqual([])
  })

  it('skips a company with no board and no careers page, without calling it a failure', async () => {
    const { store, calls } = memoryStore()
    const fetchPage = fetcher(PLAIN_PAGE)
    const out = await ingestCompany(store, company('c1', { career_url: null }), { fetchPage, model: null })
    expect(out).toMatchObject({ skipped: true, failure: null, reader: null })
    expect(fetchPage).not.toHaveBeenCalled()
    expect(calls.stamped).toEqual(['c1'])
  })

  it('reports a company whose lock is held as busy, not failed, and reads nothing', async () => {
    const { store, calls } = memoryStore({ lock: 'busy' })
    const fetchPage = fetcher(PLAIN_PAGE)
    const out = await ingestCompany(store, company('c1'), { fetchPage, model: null })
    expect(out.result.busy).toBe(true)
    expect(out.failure).toBeNull()
    expect(fetchPage).not.toHaveBeenCalled()
    expect(calls.locks).toEqual(['acquire:c1'])
  })

  it('releases the lock after a page read', async () => {
    const { store, calls } = memoryStore()
    await ingestCompany(store, company('c1'), { fetchPage: fetcher(new Error('http_500')), model: null })
    expect(calls.locks).toEqual(['acquire:c1', 'release:c1'])
  })

  it('reports why a careers page could not be read', async () => {
    const { store } = memoryStore()
    expect((await ingestCompany(store, company('a'), { fetchPage: fetcher(new Error('x')), model: null })).failure).toBe('fetch_failed')
    expect((await ingestCompany(store, company('b'), { fetchPage: fetcher(PLAIN_PAGE), model: null })).failure).toBe('model_unavailable')
    expect((await ingestCompany(store, company('c'), { fetchPage: fetcher(PLAIN_PAGE), model: async () => MODEL_LIMIT })).failure).toBe('model_limit')
    const ungrounded: ModelCall = async () => JSON.stringify({ page_kind: 'listing', jobs: [{ title: 'Chief Wizard', link: 1 }] })
    expect((await ingestCompany(store, company('d'), { fetchPage: fetcher(PLAIN_PAGE), model: ungrounded })).failure).toBe('page_unconfirmed')
  })
})

function runsStore() {
  const rows: { start: unknown; patch?: RunPatch }[] = []
  const runs: RunsStore = {
    async start(row) {
      rows.push({ start: row })
      return `run-${rows.length}`
    },
    async finish(id, patch) {
      rows[Number(id.split('-')[1]) - 1].patch = patch
    },
  }
  return { runs, rows }
}

describe('ingestUser', () => {
  it('writes one run row whose totals are the sum of the companies', async () => {
    const { store } = memoryStore()
    const { runs, rows } = runsStore()
    const budget = newModelBudget(10)
    const summary = await ingestUser(
      'user-1',
      [company('a'), company('b'), company('c', { career_url: null })],
      { store, runs, requirements: null, budget, deadlineAt: Date.now() + 60_000, fetchPage: fetcher(ldPage(['Backend Engineer', 'Designer'])), model: null },
      { batchId: 'batch-1' }
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].start).toMatchObject({ batch_id: 'batch-1', user_id: 'user-1', companies_total: 3 })
    const p = summary.patch
    expect(p).toMatchObject({ status: 'succeeded', partial_reason: null, companies_checked: 3, companies_failed: 0, jobs_found: 4, jobs_new: 4, jobs_updated: 0, jobs_closed: 0 })
    expect(p.by_provider.page_reader).toMatchObject({ companies: 2, found: 4, new: 4, failed: 0 })
    expect(rows[0].patch).toBe(p)
  })

  it('stops starting companies at the deadline and says the run was cut short', async () => {
    const { store } = memoryStore()
    const { runs } = runsStore()
    let t = 0
    const summary = await ingestUser(
      'user-1',
      [company('a'), company('b'), company('c')],
      {
        store,
        runs,
        requirements: null,
        budget: newModelBudget(10),
        deadlineAt: 1_000,
        // Each look at the clock is later than the last: only the first company starts in time.
        now: () => (t += 400),
        concurrency: 1,
        fetchPage: fetcher(ldPage(['Backend Engineer'])),
        model: null,
      },
      { batchId: 'b' }
    )
    expect(summary.patch.status).toBe('partial')
    expect(summary.patch.partial_reason).toBe('time')
    expect(summary.patch.companies_failed).toBe(2)
    expect(summary.patch.failed_companies.map((f) => f.reason)).toEqual(['time', 'time'])
    expect(summary.patch.failed_companies[0].provider).toBe('not_reached')
  })

  it('reports an exhausted model allowance as model_limit', async () => {
    const { store } = memoryStore()
    const { runs } = runsStore()
    const budget = newModelBudget(0)
    const summary = await ingestUser(
      'user-1',
      [company('a')],
      { store, runs, requirements: null, budget, deadlineAt: Date.now() + 60_000, fetchPage: fetcher(PLAIN_PAGE), model: async () => { budget.hit = true; return MODEL_LIMIT } },
      { batchId: 'b' }
    )
    expect(summary.patch).toMatchObject({ status: 'failed', partial_reason: 'model_limit', companies_failed: 1 })
    expect(summary.patch.failed_companies[0]).toMatchObject({ company_id: 'a', provider: 'page_reader', reason: 'model_limit' })
  })

  it('is partial, with the reason errors, when only some companies failed, and failed when all did', async () => {
    const { store } = memoryStore()
    const { runs } = runsStore()
    const fetchPage: FetchPage = async (url) => {
      if (url.includes('b.example')) throw new Error('http_500')
      return { html: ldPage(['Backend Engineer']), finalUrl: url, rendered: false }
    }
    const a = company('a', { career_url: 'https://a.example/careers' })
    const b = company('b', { career_url: 'https://b.example/careers' })
    const deps = { store, runs, requirements: null, budget: newModelBudget(5), deadlineAt: Date.now() + 60_000, fetchPage, model: null }
    const some = await ingestUser('user-1', [a, b], deps, { batchId: 'b' })
    expect(some.patch).toMatchObject({ status: 'partial', partial_reason: 'errors', companies_checked: 1, companies_failed: 1 })
    expect(some.patch.failed_companies).toEqual([{ company_id: 'b', provider: 'page_reader', reason: 'fetch_failed' }])

    const all = await ingestUser('user-1', [b], deps, { batchId: 'b' })
    expect(all.patch.status).toBe('failed')
    expect(all.patch.failures_by_provider).toEqual({ page_reader: 1 })
  })
})

describe('isDue', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()
  it('is due when never checked, daily by default, hourly for a dream company', () => {
    expect(isDue({ last_scraped_at: null, is_dream_company: false, scrape_frequency: null }, now)).toBe(true)
    expect(isDue({ last_scraped_at: ago(600), is_dream_company: false, scrape_frequency: null }, now)).toBe(false)
    expect(isDue({ last_scraped_at: ago(1500), is_dream_company: false, scrape_frequency: null }, now)).toBe(true)
    expect(isDue({ last_scraped_at: ago(90), is_dream_company: true, scrape_frequency: null }, now)).toBe(true)
    expect(isDue({ last_scraped_at: ago(30), is_dream_company: true, scrape_frequency: null }, now)).toBe(false)
  })
  it('lets a larger frequency stretch the interval and never shorten it', () => {
    expect(isDue({ last_scraped_at: ago(1500), is_dream_company: false, scrape_frequency: 4000 }, now)).toBe(false)
    expect(isDue({ last_scraped_at: ago(600), is_dream_company: false, scrape_frequency: 10 }, now)).toBe(false)
  })
})
