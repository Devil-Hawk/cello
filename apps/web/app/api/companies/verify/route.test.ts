// POST /api/companies/verify. The AI path used to read a column that does not
// exist, so it never ran; it now loads keys with the guarded request-context
// loader and calls the model through the REAL callLlm. Only callLlm's edges are
// faked (provider call, admin client, spend's DB functions), so the budget
// check, spend record and trace span are proven to happen. ZERO network.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const callOpenRouterMock = vi.fn()
vi.mock('@/lib/harness/providers/openrouter', () => ({
  callOpenRouter: (...args: unknown[]) => callOpenRouterMock(...args),
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
}))

const assertWithinBudgetMock = vi.fn()
const recordSpendMock = vi.fn()
vi.mock('@/lib/harness/spend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/harness/spend')>()),
  assertWithinBudget: (...args: unknown[]) => assertWithinBudgetMock(...args),
  recordSpend: (...args: unknown[]) => recordSpendMock(...args),
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

let user: { id: string } | null
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }),
}))

const getDecryptedApiKeysMock = vi.fn()
vi.mock('@/lib/apikeys', () => ({
  getDecryptedApiKeys: (...args: unknown[]) => getDecryptedApiKeysMock(...args),
}))

vi.mock('@/lib/security/untrusted', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/security/untrusted')>()), assertSsrfSafe: async () => undefined }))

import { POST } from './route'
import { BudgetCapError } from '@/lib/harness/spend'

const PAGE = `<html><head><title>Careers at Acme</title></head><body>
  <a href="/jobs/1">Engineer</a> Join us. We are hiring. Apply for open positions and opportunities.</body></html>`

const AI_VERDICT = JSON.stringify({
  isCareerPage: true,
  isOfficialPage: true,
  companyName: 'Acme Corp',
  estimatedJobCount: 12,
  confidence: 0.92,
  reasoning: 'Official careers page with listings.',
})

function llmResult(content: string) {
  return { content, tokensUsed: 4500, promptTokens: 4000, completionTokens: 500, model: 'openai/gpt-4o-mini' }
}

function post(url = 'https://acme.com/careers') {
  return new NextRequest('http://localhost/api/companies/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
}

function fallbackLines(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[llm:fallback]'))
}

beforeEach(() => {
  callOpenRouterMock.mockReset()
  assertWithinBudgetMock.mockReset().mockResolvedValue(undefined)
  recordSpendMock.mockReset().mockResolvedValue(undefined)
  getDecryptedApiKeysMock.mockReset().mockResolvedValue({ openrouter: 'sk-or-test', userId: 'user-1' })
  insertedSpans.length = 0
  user = { id: 'user-1' }
  globalThis.fetch = vi.fn(async () => new Response(PAGE, { status: 200 })) as unknown as typeof fetch
})

describe('AI verification (the path that never ran)', () => {
  it('loads keys through the guarded loader, calls the model, and is budget-checked, metered and traced', async () => {
    callOpenRouterMock.mockResolvedValue(llmResult(AI_VERDICT))

    const res = await POST(post())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ aiVerified: true, status: 'ai_verified', isValid: true, companyName: 'Acme Corp', jobCount: 12 })
    expect(getDecryptedApiKeysMock).toHaveBeenCalledWith('user-1')
    expect(callOpenRouterMock.mock.calls[0][1]).toMatchObject({
      model: 'openai/gpt-4o-mini',
      maxTokens: 500,
      temperature: 0.1,
      reasoning: { effort: 'none' },
    })
    expect(assertWithinBudgetMock).toHaveBeenCalledWith(fakeAdmin, 'user-1')
    expect(recordSpendMock).toHaveBeenCalledWith(fakeAdmin, 'user-1', 'openai/gpt-4o-mini', 4000, 500)
    expect(insertedSpans).toHaveLength(1)
    expect(insertedSpans[0]).toMatchObject({
      user_id: 'user-1',
      kind: 'llm',
      status: 'ok',
      attributes: { model: 'openai/gpt-4o-mini', metered: true, userId: 'user-1' },
    })
  })
})

describe('every fallback is still the heuristic verifier, never a 500', () => {
  async function expectHeuristic() {
    const res = await POST(post())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.aiVerified).toBe(false)
    expect(body.message).toContain('heuristic')
    expect(body.status).not.toBe('error')
  }

  it('no key: the model is never called and nothing is metered', async () => {
    getDecryptedApiKeysMock.mockResolvedValue({ userId: 'user-1' })
    await expectHeuristic()
    expect(callOpenRouterMock).not.toHaveBeenCalled()
    expect(assertWithinBudgetMock).not.toHaveBeenCalled()
    expect(recordSpendMock).not.toHaveBeenCalled()
  })

  it('a spent budget refuses before the provider call and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    assertWithinBudgetMock.mockRejectedValue(new BudgetCapError(1, 1))
    await expectHeuristic()
    expect(callOpenRouterMock).not.toHaveBeenCalled()
    expect(recordSpendMock).not.toHaveBeenCalled()
    expect(fallbackLines(warn)[0]).toContain('BudgetCapError')
  })

  it('a provider 402 falls back with no spend recorded and a warning carrying the status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    callOpenRouterMock.mockRejectedValue(Object.assign(new Error('402 Insufficient credits'), { status: 402 }))
    await expectHeuristic()
    expect(recordSpendMock).not.toHaveBeenCalled()
    const lines = fallbackLines(warn)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"scope":"company-verify"')
    expect(lines[0]).toContain('"status":402')
  })

  it('an expired demo (the key loader throws) falls back and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getDecryptedApiKeysMock.mockRejectedValue(new Error('demo session expired'))
    await expectHeuristic()
    expect(callOpenRouterMock).not.toHaveBeenCalled()
    expect(fallbackLines(warn)[0]).toContain('demo session expired')
  })

  it('model output that is not a usable verdict falls back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    callOpenRouterMock.mockResolvedValue(llmResult('{"isCareerPage": "maybe"}'))
    await expectHeuristic()
    expect(fallbackLines(warn)).toHaveLength(1)
  })
})

describe('the page is read as Cello, once, and named by its employer', () => {
  type Call = { url: string; ua: string }
  function recordFetch(answer: (url: string) => Response): Call[] {
    const calls: Call[] = []
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, ua: String((init?.headers as Record<string, string>)?.['user-agent'] ?? '') })
      return answer(url)
    }) as unknown as typeof fetch
    return calls
  }
  const noAi = () => getDecryptedApiKeysMock.mockResolvedValue({ userId: 'user-1' })

  it('every request names Cello and none claims to be a browser', async () => {
    noAi()
    const calls = recordFetch((url) => (url.endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } })))
    await POST(post())
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.ua).toContain('cello-job-tracker')
      expect(c.ua).not.toMatch(/Mozilla|Chrome|Safari/)
    }
  })

  it('a site that refuses is asked once and never again under another identity, and the answer says why', async () => {
    noAi()
    const calls = recordFetch((url) => (url.endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response('Forbidden', { status: 403 })))
    const body = await (await POST(post('https://acme.com/careers'))).json()
    expect(calls.filter((c) => !c.url.endsWith('/robots.txt'))).toHaveLength(1)
    expect(body.message).toContain('bot check')
  })

  it('a site whose robots.txt disallows the page is not read at all', async () => {
    noAi()
    const calls = recordFetch((url) => (url.endsWith('/robots.txt') ? new Response('User-agent: *\nDisallow: /careers\n', { status: 200 }) : new Response(PAGE, { status: 200 })))
    const body = await (await POST(post('https://acme.com/careers'))).json()
    expect(calls.map((c) => c.url)).toEqual(['https://acme.com/robots.txt'])
    expect(body.message).toContain('robots.txt')
  })

  it('a marketing title is not the company name: a page titled "Find your career" at jobs.zalando.com is Zalando', async () => {
    noAi()
    recordFetch((url) =>
      url.endsWith('/robots.txt')
        ? new Response('', { status: 404 })
        : new Response('<html><head><title>Find your career</title></head><body><a href="/en/jobs/1">Role</a> careers jobs hiring apply</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    )
    const body = await (await POST(post('https://jobs.zalando.com/en/jobs/'))).json()
    expect(body.companyName).toBe('Zalando')
  })

  it('a model that answers with the slogan does not name the company either', async () => {
    callOpenRouterMock.mockResolvedValue(llmResult(JSON.stringify({ isCareerPage: true, isOfficialPage: true, companyName: 'Find your career', estimatedJobCount: 3, confidence: 0.9, reasoning: 'ok' })))
    recordFetch((url) => (url.endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response('<html><head><title>Find your career</title></head><body>careers</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })))
    const body = await (await POST(post('https://jobs.zalando.com/en/jobs/'))).json()
    expect(body.companyName).toBe('Zalando')
  })
})
