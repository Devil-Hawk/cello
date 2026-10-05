// POST /api/scraper/trigger: the in-app check of one company. It runs the same
// code as the scheduled check, so these tests pin what is specific to the route:
// a page that declares its postings is read with no key and no model, a page that
// needs a browser is left to the schedule with an honest answer, a refusal is
// reported with its reason, no model or paid provider is ever called, and nothing
// identifying a company reaches the server log. ZERO network.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AtsStore, JobUpsertRow } from '@/lib/ats'

const callLlmMock = vi.fn()
vi.mock('@/lib/harness/llm', () => ({ callLlm: (...a: unknown[]) => callLlmMock(...a), parseJsonLoose: (s: string) => JSON.parse(s) }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/trace/spans', () => ({ withTrace: async (_a: unknown, _u: unknown, _s: unknown, fn: () => unknown) => fn() }))

// No test here touches the network: the plain fetcher resolves hosts through this, so the check is faked.
vi.mock('@/lib/security/untrusted', async (orig) => ({
  ...(await orig<typeof import('@/lib/security/untrusted')>()),
  assertSsrfSafe: async () => {},
}))

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
    async clearBoardJobs() {
      return { deleted: 0, closed: 0 }
    },
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

let pageHtml = LD_PAGE
let fetchMock: ReturnType<typeof vi.fn<unknown[], Promise<Response>>>

beforeEach(() => {
  callLlmMock.mockReset()
  pageHtml = LD_PAGE
  state.lock = true
  state.upserted = []
  // The careers page answers; every board probe and every other address misses, so the company has no board.
  fetchMock = vi.fn<unknown[], Promise<Response>>(async (input) => {
    const url = String(input)
    return url === COMPANY.career_url ? new Response(pageHtml, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('not found', { status: 404 })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

describe('POST /api/scraper/trigger', () => {
  it('reads a page that declares its postings, needs no key and no model, and says how it was read', async () => {
    const body = await (await POST(post())).json()
    expect(body).toMatchObject({ success: true, jobsFound: 1, inserted: 1, reason: null, tier: 'listing' })
    expect(body.message).toBe('Found 1 jobs at Acme Robotics through its careers page')
    expect(state.upserted[0]).toMatchObject({ title: 'Senior Software Engineer', source: 'listing' })
    expect(callLlmMock).not.toHaveBeenCalled()
  })

  it('a page that builds its list in a browser is left to the scheduled check, and the answer says so', async () => {
    pageHtml = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
    const body = await (await POST(post())).json()
    expect(body).toMatchObject({ success: true, jobsFound: 0, inserted: 0, reading: true })
    expect(body.message).toMatch(/^Cello is reading this site\. Next check around \d\d:\d\d UTC\.$/)
    expect(state.upserted).toEqual([])
  })

  it('a site that asks for a bot check is not read, and the answer says why', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === COMPANY.career_url ? new Response('<title>Just a moment...</title>', { status: 403 }) : new Response('nf', { status: 404 })
    )
    const body = await (await POST(post())).json()
    expect(body).toMatchObject({ success: false, jobsFound: 0, reason: 'bot_check' })
    expect(body.message).toContain('bot check')
  })

  it('never calls a model, and never calls OpenAI or Anthropic', async () => {
    pageHtml = PLAIN_PAGE
    await POST(post())
    const hosts = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(hosts.some((u) => u.includes('api.openai.com') || u.includes('api.anthropic.com') || u.includes('openrouter'))).toBe(false)
    expect(callLlmMock).not.toHaveBeenCalled()
  })

  it('asks every site as Cello, naming the repository', async () => {
    await POST(post())
    const calls = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('https://acme-robotics.example'))
    expect(calls.length).toBeGreaterThan(0)
    for (const [, init] of calls) {
      expect(String((init as RequestInit).headers && ((init as RequestInit).headers as Record<string, string>)['user-agent'])).toContain('github.com/Devil-Hawk/cello')
    }
  })

  it('says so when the company is already being checked', async () => {
    state.lock = false
    const body = await (await POST(post())).json()
    expect(body).toMatchObject({ success: true, jobsFound: 0, inserted: 0 })
    expect(body.message).toContain('already being checked')
  })

  it('writes the company name and address nowhere in the server log', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}))
    pageHtml = PLAIN_PAGE
    await POST(post())
    pageHtml = LD_PAGE
    await POST(post())
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n')
    expect(logged).not.toContain('Acme')
    expect(logged).not.toContain('acme-robotics')
    spies.forEach((s) => s.mockRestore())
  })
})
