// POST /api/scraper/trigger. The OpenRouter extraction now goes through the
// REAL callLlm with only its edges faked (provider call, admin client, spend's
// DB functions), so the budget check, spend record and trace span are proven to
// happen. Every failure still lands on the deterministic JSON-LD / HTML
// extractor, and now logs why. ZERO network.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const callOpenRouterMock = vi.fn()
vi.mock('@/lib/harness/providers/openrouter', () => ({
  callOpenRouter: (...args: unknown[]) => callOpenRouterMock(...args),
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
}))

const reserveSpendMock = vi.fn()
const settleSpendMock = vi.fn()
const RESERVATION = { id: 'res-1', userId: 'user-1', model: 'm', estimateUsd: 0.01 }
vi.mock('@/lib/harness/spend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/harness/spend')>()),
  reserveSpend: (...args: unknown[]) => reserveSpendMock(...args),
  settleSpend: (...args: unknown[]) => settleSpendMock(...args),
}))

const insertedSpans: Record<string, unknown>[] = []
const fakeAdmin = {
  from: (name: string) => {
    if (name !== 'trace_spans') throw new Error(`unexpected table "${name}"`)
    return {
      insert: async (rows: Record<string, unknown>[]) => {
        insertedSpans.push(...rows)
        return { error: null }
      },
    }
  },
}
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => fakeAdmin }))

const getDecryptedApiKeysMock = vi.fn()
vi.mock('@/lib/apikeys', () => ({
  getDecryptedApiKeys: (...args: unknown[]) => getDecryptedApiKeysMock(...args),
}))

const upserted: Record<string, unknown>[][] = []
function tableChain(table: string) {
  const rows: Record<string, unknown> =
    table === 'companies'
      ? { id: 'co-1', name: 'Acme', career_url: 'https://acme.com/careers', user_id: 'user-1' }
      : { preferences: {} }
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: rows, error: null }),
    update: () => chain,
    upsert: async (r: Record<string, unknown>[]) => {
      upserted.push(r)
      return { error: null }
    },
    // `await supabase.from('jobs').select().eq()` (existing external ids)
    then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
  }
  return chain
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => tableChain(table),
  }),
}))

import { POST } from './route'
import { BudgetCapError } from '@/lib/harness/spend'

// The deterministic extractor reads JSON-LD, so a page with one real posting
// proves the fallback ran (the AI answers below return a different job).
const PAGE = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting',
  title: 'Senior Software Engineer',
  url: 'https://acme.com/jobs/deterministic',
  jobLocation: { name: 'Remote' },
})}</script></head><body><a href="/jobs/x">x</a></body></html>`

const AI_JOBS = JSON.stringify([
  { title: 'Staff Software Engineer', url: 'https://acme.com/jobs/from-ai', location: 'Remote' },
])

function llmResult(content: string) {
  return { content, tokensUsed: 5000, promptTokens: 4500, completionTokens: 500, model: 'google/gemini-2.0-flash-001' }
}

function post() {
  return new NextRequest('http://localhost/api/scraper/trigger', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ companyId: 'co-1' }),
  })
}

function fallbackLines(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[llm:fallback]'))
}

let fetchMock: ReturnType<typeof vi.fn<unknown[], Promise<Response>>>

beforeEach(() => {
  callOpenRouterMock.mockReset()
  reserveSpendMock.mockReset().mockResolvedValue(RESERVATION)
  settleSpendMock.mockReset().mockResolvedValue(undefined)
  getDecryptedApiKeysMock.mockReset().mockResolvedValue({ openrouter: 'sk-or-test', userId: 'user-1' })
  insertedSpans.length = 0
  upserted.length = 0
  fetchMock = vi.fn<unknown[], Promise<Response>>(async () => new Response(PAGE, { status: 200 }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

describe('OpenRouter extraction is budget-checked, metered and traced', () => {
  it('goes through callLlm on the cheap model and uses the AI jobs', async () => {
    callOpenRouterMock.mockResolvedValue(llmResult(AI_JOBS))

    const res = await POST(post())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.jobsInserted).toBe(1)
    expect((upserted[0][0] as { url: string }).url).toBe('https://acme.com/jobs/from-ai')
    expect(callOpenRouterMock.mock.calls[0][1]).toMatchObject({
      model: 'google/gemini-2.0-flash-001',
      maxTokens: 4096,
      reasoning: { effort: 'none' },
    })
    expect(reserveSpendMock).toHaveBeenCalledWith(fakeAdmin, expect.objectContaining({ userId: 'user-1', model: 'google/gemini-2.0-flash-001' }))
    expect(settleSpendMock).toHaveBeenCalledWith(fakeAdmin, RESERVATION, { model: 'google/gemini-2.0-flash-001', promptTokens: 4500, completionTokens: 500, costUsd: undefined })
    expect(insertedSpans).toHaveLength(1)
    expect(insertedSpans[0]).toMatchObject({
      user_id: 'user-1',
      kind: 'llm',
      status: 'ok',
      attributes: { model: 'google/gemini-2.0-flash-001', promptTokens: 4500, completionTokens: 500, metered: true },
    })
    // The raw OpenRouter endpoint is never hit directly any more.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('openrouter.ai'))).toBe(false)
  })
})

describe('every failure still falls back to deterministic extraction', () => {
  async function expectDeterministic() {
    const res = await POST(post())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.jobsInserted).toBe(1)
    expect((upserted[0][0] as { url: string }).url).toBe('https://acme.com/jobs/deterministic')
  }

  it('no key at all: no model call, no metering', async () => {
    getDecryptedApiKeysMock.mockResolvedValue({ userId: 'user-1' })
    await expectDeterministic()
    expect(callOpenRouterMock).not.toHaveBeenCalled()
    expect(reserveSpendMock).not.toHaveBeenCalled()
    expect(settleSpendMock).not.toHaveBeenCalled()
  })

  it('a spent budget refuses before the provider call, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reserveSpendMock.mockRejectedValue(new BudgetCapError(1, 1))
    await expectDeterministic()
    expect(callOpenRouterMock).not.toHaveBeenCalled()
    expect(settleSpendMock).not.toHaveBeenCalled()
    expect(fallbackLines(warn)[0]).toContain('BudgetCapError')
  })

  it('a provider 402 settles its reservation as failed and warns with the status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    callOpenRouterMock.mockRejectedValue(Object.assign(new Error('402 Insufficient credits'), { status: 402 }))
    await expectDeterministic()
    expect(settleSpendMock).toHaveBeenCalledWith(fakeAdmin, RESERVATION, { failed: expect.objectContaining({ status: 402 }) })
    const lines = fallbackLines(warn)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"scope":"scraper-trigger"')
    expect(lines[0]).toContain('"status":402')
  })

  it('an anthropic-only account whose direct call fails (non-2xx) now warns instead of failing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getDecryptedApiKeysMock.mockResolvedValue({ anthropic: 'sk-ant-test', userId: 'user-1' })
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url).includes('api.anthropic.com')
        ? new Response(JSON.stringify({ error: { message: 'model retired' } }), { status: 404 })
        : new Response(PAGE, { status: 200 })
    )
    await expectDeterministic()
    expect(callOpenRouterMock).not.toHaveBeenCalled()
    const lines = fallbackLines(warn)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"status":404')
  })
})
