// POST /api/scraper/trigger: the in-app check of one company. It runs the same
// code as the scheduled check, so these tests pin what is specific to the route:
// a page with structured data needs no key, a page that needs a model uses only
// the user's OpenRouter key on a free model, no paid provider is ever called
// directly, and nothing identifying a company reaches the server log. ZERO network.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AtsStore, JobUpsertRow } from '@/lib/ats'

const callLlmMock = vi.fn()
vi.mock('@/lib/harness/llm', () => ({ callLlm: (...a: unknown[]) => callLlmMock(...a), parseJsonLoose: (s: string) => JSON.parse(s) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/trace/spans', () => ({ withTrace: async (_a: unknown, _u: unknown, _s: unknown, fn: () => unknown) => fn() }))

const getKeysMock = vi.fn()
vi.mock('@/lib/apikeys', () => ({ getDecryptedApiKeys: (...a: unknown[]) => getKeysMock(...a) }))

const fetchPageMock = vi.fn()
vi.mock('@/lib/ingest/fetch-page', () => ({ staticFetchPage: (...a: unknown[]) => fetchPageMock(...a) }))

const state = { lock: true, upserted: [] as JobUpsertRow[] }
vi.mock('@/lib/ats/store', () => ({
  makeSupabaseAtsStore: (): AtsStore => ({
    async listJobs() {
      return []
    },
    async upsertJobs(rows) {
      state.upserted.push(...rows)
    },
    async updateJobs(rows) {
      return rows.length
    },
    async recordSightings(_c, ids) {
      return { seen: ids.length, reopened: 0, missed: 0, closed: 0 }
    },
    async acquireCompanyLock() {
      return state.lock
    },
    async releaseCompanyLock() {},
    async saveCompanyMetadata() {},
    async updateCompanyLastScraped() {},
  }),
}))

const COMPANY = { id: 'co-1', name: 'Acme Robotics', career_url: 'https://acme-robotics.example/careers', user_id: 'user-1', domain: null, metadata: {} }
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: COMPANY, error: null }),
      }
      return chain
    },
  }),
}))

import { POST } from './route'

const FILLER = 'We are a small team that cares about customers and about each other. '.repeat(4)
const LD_PAGE = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting',
  title: 'Senior Software Engineer',
  url: 'https://acme-robotics.example/jobs/1',
  description: `<p>${'You will build and run things for customers. '.repeat(10)}</p>`,
})}</script></head><body>${FILLER}</body></html>`
const PLAIN_PAGE = `<html><body><p>${FILLER}</p><div><h3>Data Analyst</h3><a href="/jobs/3">Apply</a></div></body></html>`

function post() {
  return new NextRequest('http://localhost/api/scraper/trigger', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ companyId: 'co-1' }),
  })
}

const page = (html: string) => async (url: string) => ({ html, finalUrl: url, rendered: false })
let fetchMock: ReturnType<typeof vi.fn<unknown[], Promise<Response>>>

beforeEach(() => {
  callLlmMock.mockReset()
  getKeysMock.mockReset().mockResolvedValue({ userId: 'user-1' })
  fetchPageMock.mockReset().mockImplementation(page(LD_PAGE))
  state.lock = true
  state.upserted = []
  // Every board probe misses, so the company has no board.
  fetchMock = vi.fn<unknown[], Promise<Response>>(async () => new Response('not found', { status: 404 }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

describe('POST /api/scraper/trigger', () => {
  it('reads a page with structured postings and needs no key at all', async () => {
    const body = await (await POST(post())).json()
    expect(body).toMatchObject({ success: true, jobsFound: 1, inserted: 1, reason: null })
    expect(state.upserted[0]).toMatchObject({ title: 'Senior Software Engineer', source: 'scraper' })
    expect(callLlmMock).not.toHaveBeenCalled()
  })

  it('with no key, a page that needs a model is reported as not read, with a reason', async () => {
    fetchPageMock.mockImplementation(page(PLAIN_PAGE))
    const body = await (await POST(post())).json()
    expect(body).toMatchObject({ success: false, jobsFound: 0, inserted: 0, reason: 'model_unavailable' })
    expect(body.message).toContain('OpenRouter key')
    expect(state.upserted).toEqual([])
  })

  it('never calls OpenAI or Anthropic directly, even when the user has only those keys', async () => {
    getKeysMock.mockResolvedValue({ userId: 'user-1', openai: 'sk-openai', anthropic: 'sk-ant' })
    fetchPageMock.mockImplementation(page(PLAIN_PAGE))
    const body = await (await POST(post())).json()
    expect(body.reason).toBe('model_unavailable')
    const hosts = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(hosts.some((u) => u.includes('api.openai.com') || u.includes('api.anthropic.com'))).toBe(false)
    expect(callLlmMock).not.toHaveBeenCalled()
  })

  it("uses the user's OpenRouter key on a free model, and stores only what the page backs up", async () => {
    getKeysMock.mockResolvedValue({ userId: 'user-1', openrouter: 'sk-or-user' })
    fetchPageMock.mockImplementation(page(PLAIN_PAGE))
    callLlmMock.mockResolvedValue({
      content: JSON.stringify({
        page_kind: 'listing',
        jobs: [
          { title: 'Data Analyst', link: 1 },
          { title: 'Chief Wizard', link: 1 },
        ],
      }),
    })
    const body = await (await POST(post())).json()
    expect(body).toMatchObject({ success: true, jobsFound: 1, inserted: 1 })
    const [keys, opts] = callLlmMock.mock.calls[0]
    expect(keys).toMatchObject({ openrouter: 'sk-or-user', userId: 'user-1' })
    expect(String(opts.model).endsWith(':free')).toBe(true)
    expect(state.upserted.map((r) => r.title)).toEqual(['Data Analyst'])
  })

  it('says so when the company is already being checked', async () => {
    state.lock = false
    const body = await (await POST(post())).json()
    expect(body).toMatchObject({ success: true, jobsFound: 0, inserted: 0 })
    expect(body.message).toContain('already being checked')
    expect(fetchPageMock).not.toHaveBeenCalled()
  })

  it('writes the company name and address nowhere in the server log', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}))
    fetchPageMock.mockImplementation(page(PLAIN_PAGE))
    await POST(post())
    fetchPageMock.mockImplementation(page(LD_PAGE))
    await POST(post())
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n')
    expect(logged).not.toContain('Acme')
    expect(logged).not.toContain('acme-robotics')
    spies.forEach((s) => s.mockRestore())
  })
})
