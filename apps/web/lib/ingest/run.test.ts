import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AtsStore, ExistingJob, JobUpsertRow } from '../ats/index'
import { MODEL_LIMIT, newModelBudget, type ModelCall } from './model'
import { ingestCompany, ingestUser, isDue, type DueCompany, type RunPatch, type RunsStore } from './run'
import type { FetchPage } from './fetch-page'
import { fakeFetcher, type Route } from './reader/fake-fetcher'
import { searchTerms, NO_TARGETS } from './reader/targets'

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

  const CAREERS = 'https://acme.example/careers'
  const site = (routes: Record<string, Route>) => fakeFetcher({ 'https://acme.example/robots.txt': { status: 404, body: '' }, ...routes })

  it('reads a company with no board through the one reader and stores what its page declares, as the employer own roles', async () => {
    const { store, calls } = memoryStore()
    const out = await ingestCompany(store, company('c1', { name: 'Acme', domain: 'acme.example' }), {
      fetchPage: fetcher(PLAIN_PAGE),
      model: null,
      fetcher: site({ [CAREERS]: ldPage(['Backend Engineer', 'Designer']) }),
    })
    expect(out.tier).toBe('listing')
    expect(out.reader).toBe('listing')
    expect(out.failure).toBeNull()
    expect(out.result).toMatchObject({ found: 2, inserted: 2 })
    expect(calls.upserted.every((r) => r.source === 'listing')).toBe(true)
    expect(calls.upserted[0].description.length).toBeGreaterThan(200)
    // A page that declares its whole list may count a missing posting as gone.
    expect(calls.sightings[0].sources).toEqual(['listing'])
  })

  it('writes what it read into the company: the tier, the requests and the roles already read', async () => {
    const saved: Record<string, unknown>[] = []
    const { store } = memoryStore()
    store.saveCompanyMetadata = async (_id, metadata) => {
      saved.push(metadata)
    }
    await ingestCompany(store, company('c1', { name: 'Acme', domain: 'acme.example' }), {
      fetchPage: fetcher(PLAIN_PAGE),
      model: null,
      fetcher: site({ [CAREERS]: ldPage(['Backend Engineer']) }),
    })
    const meta = saved[saved.length - 1]
    expect(meta.source_check).toMatchObject({ readable: true, tier: 'listing' })
    expect(meta.reader).toMatchObject({ tier: 'listing', targets_key: '' })
  })

  it('a board the company own site links to is verified, saved as the company board and read through its adapter', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('boards-api.greenhouse.io/v1/boards/acmeco/jobs'))
        return new Response(JSON.stringify({ jobs: [{ absolute_url: 'https://acme.example/jobs/9', title: 'Backend Engineer', first_published: new Date().toISOString(), content: '&lt;p&gt;Build.&lt;/p&gt;' }] }), { status: 200 })
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch
    const saved: Record<string, unknown>[] = []
    const { store, calls } = memoryStore()
    store.saveCompanyMetadata = async (_id, metadata) => {
      saved.push(metadata)
    }
    const out = await ingestCompany(store, company('c1', { name: 'Acme', domain: 'acme.example' }), {
      fetchPage: fetcher(PLAIN_PAGE),
      model: null,
      fetcher: site({ [CAREERS]: '<html><body><a href="https://boards.greenhouse.io/acmeco">Open roles</a></body></html>' }),
    })
    expect(out.tier).toBe('board')
    expect(out.reader).toBe('greenhouse')
    expect(calls.upserted[0].source).toBe('greenhouse')
    expect(saved[saved.length - 1].ats).toMatchObject({ provider: 'greenhouse', token: 'acmeco', verified_by: 'careers_page_link' })
  })

  it('scheduled, a page only a browser can read is rendered and read by the model; its rows close only on a complete read', async () => {
    const { store, calls } = memoryStore()
    const model: ModelCall = async () => JSON.stringify({ page_kind: 'listing', jobs: [{ title: 'Data Analyst', link: 1 }] })
    // A page too long for the snapshot, so the list may be cut short.
    const big = `<html><body>${'<p>filler text for the page</p>'.repeat(3000)}<div><h3>Data Analyst</h3><a href="/jobs/3">Apply</a></div></body></html>`
    const out = await ingestCompany(store, company('c1'), {
      fetchPage: vi.fn(async (url: string) => ({ html: big, finalUrl: url, rendered: true })),
      model,
      mode: 'scheduled',
      fetcher: fakeFetcher({ [CAREERS]: '<html><body><div id="root"></div></body></html>' }, 'scheduled'),
    })
    expect(out.tier).toBe('model')
    expect(out.reader).toBe('page_reader')
    expect(out.result.found).toBe(1)
    expect(calls.sightings[0].sources).toEqual([])
  })

  it('inline, a script-built page is left to the scheduled pass: the company says it is being read, not that it failed', async () => {
    const { store } = memoryStore()
    const fetchPage = fetcher(PLAIN_PAGE)
    const model = vi.fn<Parameters<ModelCall>, ReturnType<ModelCall>>()
    const out = await ingestCompany(store, company('c1'), {
      fetchPage,
      model,
      fetcher: site({ [CAREERS]: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>' }),
    })
    expect(out).toMatchObject({ reading: true, failure: null, tier: null })
    expect(fetchPage).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
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

  it('releases the lock after a site read', async () => {
    const { store, calls } = memoryStore()
    await ingestCompany(store, company('c1'), { fetchPage: fetcher(new Error('http_500')), model: null, fetcher: site({}) })
    expect(calls.locks).toEqual(['acquire:c1', 'release:c1'])
  })

  it('reports why a careers site could not be read', async () => {
    const { store } = memoryStore()
    const run = (id: string, routes: Record<string, Route>) => ingestCompany(store, company(id), { fetchPage: fetcher(PLAIN_PAGE), model: null, fetcher: site(routes) })
    expect((await run('a', { [CAREERS]: { error: 'bot_check' } })).failure).toBe('bot_check')
    expect((await run('b', { [CAREERS]: { error: 'login_required' } })).failure).toBe('login_required')
    expect((await run('c', { 'https://acme.example/robots.txt': 'User-agent: *\nDisallow: /\n', [CAREERS]: PLAIN_PAGE })).failure).toBe('robots')
    expect((await run('d', { [CAREERS]: `<html><body><p>${'We are a company that cares about people. '.repeat(40)}</p></body></html>` })).failure).toBe('no_roles')
  })

  it('writes the reason into the company so the screen can say it instead of "0 open roles"', async () => {
    const saved: Record<string, unknown>[] = []
    const { store } = memoryStore()
    store.saveCompanyMetadata = async (_id, metadata) => {
      saved.push(metadata)
    }
    await ingestCompany(store, company('c1'), { fetchPage: fetcher(PLAIN_PAGE), model: null, fetcher: site({ [CAREERS]: { error: 'bot_check' } }) })
    expect(saved[saved.length - 1].source_check).toMatchObject({ readable: false, reason: 'bot_check' })
  })

  it('targets drive the search: a person who typed titles gets those words, one who set functions gets theirs', () => {
    expect(searchTerms({ ...NO_TARGETS, titles: ['data engineer', 'analytics engineer'] })).toEqual(['data engineer', 'analytics engineer'])
    expect(searchTerms({ targeting: { ...NO_TARGETS.targeting, functions: ['engineering', 'data'] }, titles: [] })).toEqual(['software engineer', 'data'])
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
      { store, runs, requirements: null, budget, deadlineAt: Date.now() + 60_000, fetchPage: fetcher(PLAIN_PAGE), model: null, fetcher: fakeFetcher({ 'https://acme.example/careers': ldPage(['Backend Engineer', 'Designer']) }) },
      { batchId: 'batch-1' }
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].start).toMatchObject({ batch_id: 'batch-1', user_id: 'user-1', companies_total: 3 })
    const p = summary.patch
    expect(p).toMatchObject({ status: 'succeeded', partial_reason: null, companies_checked: 3, companies_failed: 0, jobs_found: 4, jobs_new: 4, jobs_updated: 0, jobs_closed: 0 })
    expect(p.by_provider.listing).toMatchObject({ companies: 2, found: 4, new: 4, failed: 0 })
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
        fetchPage: fetcher(PLAIN_PAGE),
        model: null,
        fetcher: fakeFetcher({ 'https://acme.example/careers': ldPage(['Backend Engineer']) }),
      },
      { batchId: 'b' }
    )
    expect(summary.patch.status).toBe('partial')
    expect(summary.patch.partial_reason).toBe('time')
    expect(summary.patch.companies_failed).toBe(2)
    expect(summary.patch.failed_companies.map((f) => f.reason)).toEqual(['time', 'time'])
    expect(summary.patch.failed_companies[0].provider).toBe('not_reached')
  })

  it('reports a site that needs a bot check as a failure with its reason, by the way it was read', async () => {
    const { store } = memoryStore()
    const { runs } = runsStore()
    const summary = await ingestUser(
      'user-1',
      [company('a')],
      { store, runs, requirements: null, budget: newModelBudget(1), deadlineAt: Date.now() + 60_000, fetchPage: fetcher(PLAIN_PAGE), model: null, fetcher: fakeFetcher({ 'https://acme.example/careers': { error: 'bot_check' } }) },
      { batchId: 'b' }
    )
    expect(summary.patch).toMatchObject({ status: 'failed', companies_failed: 1 })
    expect(summary.patch.failed_companies[0]).toMatchObject({ company_id: 'a', reason: 'bot_check' })
  })

  it('is partial, with the reason errors, when only some companies failed, and failed when all did', async () => {
    const { store } = memoryStore()
    const { runs } = runsStore()
    const f = fakeFetcher({
      'https://a.example/careers': ldPage(['Backend Engineer']),
      'https://b.example/careers': { error: 'unreachable' },
    })
    const a = company('a', { career_url: 'https://a.example/careers' })
    const b = company('b', { career_url: 'https://b.example/careers' })
    const deps = { store, runs, requirements: null, budget: newModelBudget(5), deadlineAt: Date.now() + 60_000, fetchPage: fetcher(PLAIN_PAGE), model: null, fetcher: f }
    const some = await ingestUser('user-1', [a, b], deps, { batchId: 'b' })
    expect(some.patch).toMatchObject({ status: 'partial', partial_reason: 'errors', companies_checked: 1, companies_failed: 1 })
    expect(some.patch.failed_companies).toEqual([{ company_id: 'b', provider: 'unknown', reason: 'unreachable' }])

    const all = await ingestUser('user-1', [b], deps, { batchId: 'b' })
    expect(all.patch.status).toBe('failed')
    expect(all.patch.failures_by_provider).toEqual({ unknown: 1 })
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
  it('a site only the scheduled pass can read is always due, and a recorded check counts like a scrape', () => {
    const reading = { source_check: { checked_at: ago(5), readable: false, reason: 'reading' } }
    expect(isDue({ last_scraped_at: ago(5), is_dream_company: false, scrape_frequency: null, metadata: reading }, now)).toBe(true)
    const checked = { source_check: { checked_at: ago(5), readable: false, reason: 'bot_check' } }
    expect(isDue({ last_scraped_at: null, is_dream_company: false, scrape_frequency: null, metadata: checked }, now)).toBe(false)
  })
  it('lets a larger frequency stretch the interval and never shorten it', () => {
    expect(isDue({ last_scraped_at: ago(1500), is_dream_company: false, scrape_frequency: 4000 }, now)).toBe(false)
    expect(isDue({ last_scraped_at: ago(600), is_dream_company: false, scrape_frequency: 10 }, now)).toBe(false)
  })
})
