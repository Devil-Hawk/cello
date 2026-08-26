// Tests for POST /api/outreach/draft — the E2E failure this closes: a raw
// judge error (autoevals' Factuality asking for more max_tokens than the
// account could afford, OpenRouter returning 402) must never 500 this route.
// insertOutreach() must run and the draft must persist 'pending_review' no
// matter what verifyOutreachDraft's judge stage does — that's the whole
// contract. Everything below verifyOutreachDraft is mocked (that module's own
// judge-failure handling is lib/graph/verify/outreach.test.ts's job).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const insertOutreachMock = vi.fn()
const findDuplicateInitialMock = vi.fn(async (..._args: unknown[]) => null)
vi.mock('@/lib/outreach/store', () => ({
  insertOutreach: (...args: unknown[]) => insertOutreachMock(...args),
  findDuplicateInitial: (...args: unknown[]) => findDuplicateInitialMock(...args),
}))

const runUnitOnceMock = vi.fn(async (..._args: unknown[]) => ({
  output: { subject: 'Hi', body: 'Draft body', tokensUsed: 10 },
  tokensUsed: 10,
}))
vi.mock('@/lib/graph/oneshot', () => ({
  runUnitOnce: (...args: unknown[]) => runUnitOnceMock(...args),
}))

interface VerifiedFixture {
  subject: string
  body: string
  tokensUsed: number
  verdicts: unknown[]
  failedVerdict: boolean
  judgeUnavailable: boolean
}
let verified: VerifiedFixture
const verifyOutreachDraftMock = vi.fn(async (..._args: unknown[]) => verified)
vi.mock('@/lib/graph/verify/outreach', () => ({
  verifyOutreachDraft: (...args: unknown[]) => verifyOutreachDraftMock(...args),
}))

const writeVerdictMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/evals/verdicts', () => ({
  writeVerdict: (...args: unknown[]) => writeVerdictMock(...args),
}))

vi.mock('@/lib/access/session', () => ({
  recordDemoEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/context/assemble', () => ({
  buildOutreachContext: vi.fn().mockResolvedValue(null),
}))

let user: { id: string; email: string } | null
const supabaseTableRow: Record<string, Record<string, unknown> | null> = {
  contacts: { id: 'contact-1', name: 'Jordan', email: 'jordan@example.com', title: 'Eng Manager', company_id: 'co-1' },
  jobs: { id: 'job-1', title: 'Staff Engineer', description: 'Build things.', company_id: 'co-1', match_details: null },
  companies: { id: 'co-1', name: 'Acme' },
  profiles: { full_name: 'Alex Candidate', resume_text: 'Senior engineer.' },
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

function post(body: unknown) {
  return new NextRequest('http://localhost/api/outreach/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  findDuplicateInitialMock.mockResolvedValue(null)
  runUnitOnceMock.mockResolvedValue({ output: { subject: 'Hi', body: 'Draft body', tokensUsed: 10 }, tokensUsed: 10 })
  writeVerdictMock.mockResolvedValue(undefined)
  user = { id: 'user-1', email: 'alex@example.com' }
  verified = { subject: 'Hi', body: 'Draft body', tokensUsed: 10, verdicts: [], failedVerdict: false, judgeUnavailable: false }
  insertOutreachMock.mockImplementation(async (_admin: unknown, row: Record<string, unknown>) => ({ id: 'msg-1', ...row }))
})

describe('POST — a broke judge cannot take the draft down with it', () => {
  it('persists pending_review and returns 2xx when verifyOutreachDraft reports judgeUnavailable', async () => {
    verified = { subject: 'Hi', body: 'Draft body', tokensUsed: 10, verdicts: [], failedVerdict: false, judgeUnavailable: true }

    const response = await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(insertOutreachMock).toHaveBeenCalledTimes(1)
    expect(insertOutreachMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'pending_review', subject: 'Hi', body: 'Draft body' })
    )
  })

  it('writes an unjudged verdict row for both judges, keyed to the persisted draft', async () => {
    verified = { subject: 'Hi', body: 'Draft body', tokensUsed: 10, verdicts: [], failedVerdict: false, judgeUnavailable: true }

    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))

    expect(writeVerdictMock).toHaveBeenCalledTimes(2)
    for (const judge of ['factuality', 'closed_qa']) {
      expect(writeVerdictMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ subjectKind: 'outreach_draft', subjectId: 'msg-1', judge, verdict: 'unjudged' })
      )
    }
    // A refusal never carries a substituted score.
    for (const call of writeVerdictMock.mock.calls) {
      expect((call[1] as { score?: number }).score).toBeUndefined()
    }
  })

  it('writes the real pass/fail verdict rows on the ordinary path (no regression)', async () => {
    verified = {
      subject: 'Hi',
      body: 'Draft body',
      tokensUsed: 10,
      verdicts: [{ name: 'outreach groundedness', verdict: 'pass', score: 0.9, threshold: 0.5, n: 1, summary: 'grounded' }],
      failedVerdict: false,
      judgeUnavailable: false,
    }

    const response = await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))

    expect(response.status).toBe(200)
    expect(writeVerdictMock).toHaveBeenCalledTimes(1)
    expect(writeVerdictMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ judge: 'factuality', verdict: 'pass', score: 0.9 })
    )
  })
})
