// Tests for POST /api/outreach/judge: the check the user asks for on one draft.
// What matters: (1) every judged draft leaves rows behind via writeVerdict
// instead of dying with the HTTP response, (2) the insufficient-budget path,
// where BudgetCapError from the model call becomes a typed, PERSISTED refusal
// (refuse over guess) and not just a 429 the client has to remember, and (3)
// the judges are shown the same numbered sources the draft was written from.
//
// The judges themselves (lib/evals/claims-judge.ts) and the source loader are
// mocked: this is a route test.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const writeVerdictMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/evals/verdicts', () => ({
  writeVerdict: (...args: unknown[]) => writeVerdictMock(...args),
}))

const judgeClaimsMock = vi.fn()
const judgeSpecificityMock = vi.fn()
const judgeRunnerMock = vi.fn((_keys: unknown, name: string) => `runner:${name}`)
vi.mock('@/lib/evals/claims-judge', () => ({
  judgeClaims: (...args: unknown[]) => judgeClaimsMock(...args),
  judgeSpecificity: (...args: unknown[]) => judgeSpecificityMock(...args),
  judgeRunner: (...args: [unknown, string]) => judgeRunnerMock(...args),
  judgeModelFor: () => 'anthropic/claude-haiku-4.5',
}))

const loadApiKeysMock = vi.fn()
vi.mock('@/lib/harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...args),
}))

vi.mock('@/lib/outreach/sources', () => ({
  loadOutreachSources: async () => ({
    senderName: 'Ada Lovelace',
    companyId: 'co-1',
    hasHistory: false,
    input: {
      userEmail: 'ada@example.com',
      jobTitle: 'Senior Backend Engineer',
      companyName: 'Acme',
      resumeText: 'Ada Lovelace\nBuilt the analytical engine',
      jobDescription: 'Build services.\nOwn the ledger.',
      facts: [{ id: 'D1', text: 'Acme ships weekly', url: 'https://acme.test/about' }],
      history: [],
    },
  }),
}))

interface MessageFixture {
  id: string
  user_id: string
  subject: string
  body: string
  contact_id: string | null
  job_id: string | null
  company_id: string | null
}

let message: MessageFixture | null
const getOutreachMock = vi.fn(async (..._args: unknown[]) => message)
vi.mock('@/lib/outreach/store', () => ({
  getOutreach: (...args: unknown[]) => getOutreachMock(...args),
}))

let user: { id: string; email?: string } | null
const supabase = { auth: { getUser: async () => ({ data: { user }, error: null }) } }
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => ({}) }))

import { POST } from './route'
import { BudgetCapError } from '@/lib/harness/spend'
import { MissingKeyError } from '@/lib/harness/providers'

function post(body: unknown) {
  return new NextRequest('http://localhost/api/outreach/judge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const PASS_RESULT = { name: 'groundedness', verdict: 'pass', score: 1, threshold: 1, summary: 'All 2 statements trace to your sources.', claims: [], unsupported: [] }
const FAIL_RESULT = { name: 'specificity', verdict: 'fail', score: 0, threshold: 1, summary: 'Generic: nothing ties to the post.', detail: null, source: null }

beforeEach(() => {
  vi.clearAllMocks()
  writeVerdictMock.mockResolvedValue(undefined)
  loadApiKeysMock.mockResolvedValue({ openrouter: 'sk-or-test' })
  judgeClaimsMock.mockResolvedValue(PASS_RESULT)
  judgeSpecificityMock.mockResolvedValue(FAIL_RESULT)
  user = { id: 'user-1', email: 'ada@example.com' }
  message = { id: 'msg-1', user_id: 'user-1', subject: 'S', body: 'Hi, I saw your posting...', contact_id: 'c-1', job_id: 'job-1', company_id: 'co-1' }
})

describe('POST, verdict persistence from the route', () => {
  it('persists both verdicts under the claim-level judge names and returns them', async () => {
    const response = await POST(post({ id: 'msg-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, groundedness: PASS_RESULT, specificity: FAIL_RESULT })
    expect(writeVerdictMock).toHaveBeenCalledTimes(2)
    expect(writeVerdictMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-1', subjectKind: 'outreach_draft', subjectId: 'msg-1', judge: 'groundedness', verdict: 'pass', score: 1, threshold: 1, model: 'anthropic/claude-haiku-4.5' })
    )
    expect(writeVerdictMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ judge: 'specificity', verdict: 'fail', score: 0, rationale: 'Generic: nothing ties to the post.' })
    )
  })

  it('shows the claims judge the numbered resume, job, research and history lines', async () => {
    await POST(post({ id: 'msg-1' }))
    const args = judgeClaimsMock.mock.calls[0]
    expect(args[0]).toBe('runner:judge-claims')
    expect(args[1].text).toBe('Hi, I saw your posting...')
    expect(args[1].sources.map((l: { id: string }) => l.id)).toEqual(['R1', 'R2', 'J1', 'J2', 'D1'])
  })

  it('shows the specificity judge the job lines and the company facts', async () => {
    await POST(post({ id: 'msg-1' }))
    const args = judgeSpecificityMock.mock.calls[0][1]
    expect(args.jobLines.map((l: { id: string }) => l.id)).toEqual(['J1', 'J2'])
    expect(args.facts[0]).toMatchObject({ id: 'D1', url: 'https://acme.test/about' })
    expect(args).toMatchObject({ role: 'Senior Backend Engineer', company: 'Acme' })
  })
})

describe('POST, the insufficient-budget verdict path', () => {
  it('persists both judges as insufficient-budget and returns 429 when the call hits the cap', async () => {
    const capError = new BudgetCapError(12.5, 10)
    judgeClaimsMock.mockRejectedValue(capError)
    judgeSpecificityMock.mockRejectedValue(capError)

    const response = await POST(post({ id: 'msg-1' }))
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(body).toMatchObject({ error: capError.message, budgetExhausted: true })
    expect(writeVerdictMock).toHaveBeenCalledTimes(2)
    for (const judge of ['groundedness', 'specificity']) {
      expect(writeVerdictMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userId: 'user-1', subjectKind: 'outreach_draft', subjectId: 'msg-1', judge, verdict: 'insufficient-budget', rationale: capError.message })
      )
    }
    // A refusal is typed, not a substituted score.
    for (const call of writeVerdictMock.mock.calls) expect((call[1] as { score?: number }).score).toBeUndefined()
  })
})

describe('POST, the rest of the contract stays intact', () => {
  it('404s a draft that does not belong to this user, and never judges it', async () => {
    message = null
    const response = await POST(post({ id: 'not-mine' }))
    expect(response.status).toBe(404)
    expect(judgeClaimsMock).not.toHaveBeenCalled()
    expect(writeVerdictMock).not.toHaveBeenCalled()
  })

  it('400s with needsKey when the model call finds no key', async () => {
    judgeClaimsMock.mockRejectedValue(new MissingKeyError())
    const response = await POST(post({ id: 'msg-1' }))
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body.needsKey).toBe(true)
    expect(writeVerdictMock).not.toHaveBeenCalled()
  })

  it('401s when nobody is signed in', async () => {
    user = null
    const response = await POST(post({ id: 'msg-1' }))
    expect(response.status).toBe(401)
  })
})
