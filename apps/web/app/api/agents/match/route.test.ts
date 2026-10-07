// POST /api/agents/match as Langfuse sees it: the root input names the job (not a
// bare uuid), a score is the output, and a handled model failure that returns a
// 500 marks the root failed instead of leaving it looking fine.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const traced = { input: [] as unknown[], output: [] as unknown[], meta: [] as unknown[], error: [] as string[] }
vi.mock('@/lib/trace/spans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trace/spans')>()
  return {
    ...actual,
    setTraceInput: (x: unknown) => (traced.input.push(x), actual.setTraceInput(x)),
    setTraceOutput: (x: unknown) => (traced.output.push(x), actual.setTraceOutput(x)),
    setTraceMeta: (x: Record<string, string>) => (traced.meta.push(x), actual.setTraceMeta(x)),
    setTraceError: (x: string) => (traced.error.push(x), actual.setTraceError(x)),
  }
})

const scoreMock = vi.fn()
vi.mock('@/lib/harness/agents/matcher', () => ({
  scoreJobWithLlm: (...a: unknown[]) => scoreMock(...a),
  buildMatchDetails: () => ({ score: 85 }),
}))
vi.mock('@/lib/harness/keys', () => ({ loadApiKeys: async () => ({ openrouter: 'k' }) }))
vi.mock('@/lib/harness/llm', () => ({ callLlm: vi.fn(), MissingKeyError: class extends Error {} }))
vi.mock('@/lib/harness/llm-key-message', () => ({ canRunLlm: () => true, missingOpenRouterMessage: () => 'no key' }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))

const rows: Record<string, unknown> = {
  profiles: { resume_text: 'Senior engineer.' },
  person_jobs: { id: 'job-1', title: 'Staff Engineer', description: 'd', location: null, company_id: 'co-1', viewer_company_name: 'Acme' },
}
const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
  from: (table: string) => {
    const chain = { select: () => chain, eq: () => chain, update: () => chain, single: async () => ({ data: rows[table] ?? null, error: null }) }
    return chain
  },
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))

import { POST } from './route'

const post = () =>
  POST(new NextRequest('http://localhost/api/agents/match', { method: 'POST', body: JSON.stringify({ jobId: 'job-1' }), headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  scoreMock.mockReset()
  traced.input.length = traced.output.length = traced.meta.length = traced.error.length = 0
})

describe('POST /api/agents/match in Langfuse', () => {
  it('input is the job title and company, the id is trace metadata, the output is the score and seniority fit', async () => {
    scoreMock.mockResolvedValue({ verdict: { score: 85, seniorityFit: 'Strong fit for senior IC' } })
    const res = await post()
    expect(res.status).toBe(200)
    expect(traced.input).toEqual([{ jobTitle: 'Staff Engineer', companyName: 'Acme' }])
    expect(traced.meta).toEqual([{ job_id: 'job-1' }])
    expect(traced.output).toEqual([{ score: 85, seniorityFit: 'Strong fit for senior IC' }])
    expect(traced.error).toEqual([])
  })

  it('a handled scoring failure answers 500 and marks the root failed', async () => {
    scoreMock.mockRejectedValue(new Error('400 invalid/model-xyz is not a valid model ID'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await post()
    expect(res.status).toBe(500)
    expect(traced.error).toEqual(['scoring-failed'])
  })
})
