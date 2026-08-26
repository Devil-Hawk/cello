// Tests for POST /api/outreach/judge — the two things the metered-judge
// migration was FOR: (1) verdict persistence, every judged draft leaves a
// row behind via writeVerdict instead of dying with the HTTP response, and
// (2) the insufficient-budget path, where BudgetCapError from inside
// meteredJudgeClient becomes a typed, PERSISTED refusal (REFUSE-OVER-GUESS,
// invariant 7) rather than just a 429 the client has to remember.
//
// Everything below meteredJudgeClient/writeVerdict is mocked — this is a
// route test, not a re-test of judge.ts's fetch wrapper (that's
// lib/evals/judge.test.ts) or verdicts.ts's insert shape (that's
// lib/evals/verdicts.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const writeVerdictMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/evals/verdicts', () => ({
  writeVerdict: (...args: unknown[]) => writeVerdictMock(...args),
}))

const meteredJudgeClientMock = vi.fn()
const judgeGroundednessMock = vi.fn()
const judgeSpecificityMock = vi.fn()
vi.mock('@/lib/evals/judge', () => ({
  meteredJudgeClient: (...args: unknown[]) => meteredJudgeClientMock(...args),
  judgeGroundedness: (...args: unknown[]) => judgeGroundednessMock(...args),
  judgeSpecificity: (...args: unknown[]) => judgeSpecificityMock(...args),
  JUDGE_MODEL: 'anthropic/claude-haiku-4.5',
}))

const assertWithinBudgetMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/harness/spend', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, assertWithinBudget: (...args: unknown[]) => assertWithinBudgetMock(...args) }
})

const loadApiKeysMock = vi.fn()
vi.mock('@/lib/harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}))

interface MessageFixture {
  id: string
  user_id: string
  body: string
  job_id: string | null
  company_id: string | null
}

let message: MessageFixture | null
const getOutreachMock = vi.fn(async (..._args: unknown[]) => message)
vi.mock('@/lib/outreach/store', () => ({
  getOutreach: (...args: unknown[]) => getOutreachMock(...args),
}))

let user: { id: string } | null
const supabaseTableRow: Record<string, Record<string, unknown> | null> = {
  jobs: { title: 'Senior Backend Engineer', description: 'Build services.' },
  companies: { name: 'Acme' },
  profiles: { resume_text: 'Ada Lovelace — engineer.' },
}
function tableChain(table: string) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: supabaseTableRow[table] ?? null, error: null }),
  }
  return chain
}
const supabase = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from: (table: string) => tableChain(table),
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))

import { POST } from './route'
import { BudgetCapError } from '@/lib/harness/spend'

function post(body: unknown) {
  return new NextRequest('http://localhost/api/outreach/judge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const PASS_RESULT = { verdict: 'pass', score: 0.9, threshold: 0.5, summary: 'looks grounded' }
const FAIL_RESULT = { verdict: 'fail', score: 0.2, threshold: 0.6, summary: 'too generic' }

beforeEach(() => {
  vi.clearAllMocks()
  assertWithinBudgetMock.mockResolvedValue(undefined)
  writeVerdictMock.mockResolvedValue(undefined)
  loadApiKeysMock.mockResolvedValue({ openrouter: 'sk-or-test' })
  meteredJudgeClientMock.mockReturnValue({ fakeClient: true })
  judgeGroundednessMock.mockResolvedValue(PASS_RESULT)
  judgeSpecificityMock.mockResolvedValue(FAIL_RESULT)
  user = { id: 'user-1' }
  message = { id: 'msg-1', user_id: 'user-1', body: 'Hi, I saw your posting...', job_id: 'job-1', company_id: 'co-1' }
})

describe('POST — verdict persistence from the route', () => {
  it('persists both judged verdicts via writeVerdict, keyed to the draft, and returns them in the response', async () => {
    const response = await POST(post({ id: 'msg-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, groundedness: PASS_RESULT, specificity: FAIL_RESULT })

    expect(writeVerdictMock).toHaveBeenCalledTimes(2)
    expect(writeVerdictMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        subjectKind: 'outreach_draft',
        subjectId: 'msg-1',
        judge: 'factuality',
        verdict: 'pass',
        score: 0.9,
        threshold: 0.5,
        rationale: 'looks grounded',
        model: 'anthropic/claude-haiku-4.5',
      })
    )
    expect(writeVerdictMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        subjectKind: 'outreach_draft',
        subjectId: 'msg-1',
        judge: 'closed_qa',
        verdict: 'fail',
        score: 0.2,
        threshold: 0.6,
        rationale: 'too generic',
      })
    )
  })

  it('builds the client through meteredJudgeClient with the caller userId, not a second key path', async () => {
    await POST(post({ id: 'msg-1' }))
    expect(meteredJudgeClientMock).toHaveBeenCalledWith(expect.anything(), 'user-1', { openrouter: 'sk-or-test' })
  })
})

describe('POST — the insufficient-budget verdict path', () => {
  it('persists both judges as insufficient-budget and returns 429 when the judge call hits the cap', async () => {
    const capError = new BudgetCapError(12.5, 10)
    judgeGroundednessMock.mockRejectedValue(capError)
    judgeSpecificityMock.mockRejectedValue(capError)

    const response = await POST(post({ id: 'msg-1' }))
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(body).toMatchObject({ error: capError.message, budgetExhausted: true })

    expect(writeVerdictMock).toHaveBeenCalledTimes(2)
    expect(writeVerdictMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        subjectKind: 'outreach_draft',
        subjectId: 'msg-1',
        judge: 'factuality',
        verdict: 'insufficient-budget',
        rationale: capError.message,
      })
    )
    expect(writeVerdictMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        subjectKind: 'outreach_draft',
        subjectId: 'msg-1',
        judge: 'closed_qa',
        verdict: 'insufficient-budget',
        rationale: capError.message,
      })
    )
    // A refusal is typed, not a substituted score.
    for (const call of writeVerdictMock.mock.calls) {
      expect((call[1] as { score?: number }).score).toBeUndefined()
    }
  })

  it('never reaches writeVerdict when assertWithinBudget itself refuses before any client is built', async () => {
    assertWithinBudgetMock.mockRejectedValue(new BudgetCapError(12.5, 10))

    const response = await POST(post({ id: 'msg-1' }))

    expect(response.status).toBe(429)
    expect(meteredJudgeClientMock).not.toHaveBeenCalled()
    expect(writeVerdictMock).toHaveBeenCalledTimes(2)
    expect(writeVerdictMock.mock.calls.every(([, input]) => (input as { verdict: string }).verdict === 'insufficient-budget')).toBe(true)
  })
})

describe('POST — the rest of the contract stays intact', () => {
  it('404s a draft that does not belong to (or does not exist for) this user, and never judges it', async () => {
    message = null
    const response = await POST(post({ id: 'not-mine' }))
    expect(response.status).toBe(404)
    expect(meteredJudgeClientMock).not.toHaveBeenCalled()
    expect(writeVerdictMock).not.toHaveBeenCalled()
  })

  it('400s with needsKey when no OpenRouter key is configured, before building a client', async () => {
    loadApiKeysMock.mockResolvedValue({})
    const response = await POST(post({ id: 'msg-1' }))
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body.needsKey).toBe(true)
    expect(meteredJudgeClientMock).not.toHaveBeenCalled()
  })

  it('401s when nobody is signed in', async () => {
    user = null
    const response = await POST(post({ id: 'msg-1' }))
    expect(response.status).toBe(401)
  })
})
