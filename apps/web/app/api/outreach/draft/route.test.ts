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
vi.mock('@/lib/outreach/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outreach/store')>()),
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

// What the route tells Langfuse about this request, recorded as it is set.
const traced = { input: [] as unknown[], output: [] as unknown[], meta: [] as unknown[] }
vi.mock('@/lib/trace/spans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trace/spans')>()
  return {
    ...actual,
    setTraceInput: (x: unknown) => (traced.input.push(x), actual.setTraceInput(x)),
    setTraceOutput: (x: unknown) => (traced.output.push(x), actual.setTraceOutput(x)),
    setTraceMeta: (x: Record<string, string>) => (traced.meta.push(x), actual.setTraceMeta(x)),
  }
})

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
  traced.input.length = traced.output.length = traced.meta.length = 0
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

describe('POST, duplicates and templates', () => {
  it('answers 409, not a raw 500, when the unique index refuses a draft that raced past the check', async () => {
    insertOutreachMock.mockRejectedValue(
      Object.assign(new Error('insertOutreach failed: duplicate key value violates unique constraint "uniq_outreach_initial_contact_job"'), { code: '23505' })
    )

    const response = await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toBe('An outreach email to this contact for this role already exists.')
    expect(body.error).not.toContain('duplicate key')
  })

  it('still answers 500 for a save failure that is not the duplicate refusal', async () => {
    insertOutreachMock.mockRejectedValue(Object.assign(new Error('insertOutreach failed: boom'), { code: '08006' }))
    const response = await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    expect(response.status).toBe(500)
  })

  it('records and reports a template draft (tokensUsed 0) as usedLlm:false', async () => {
    verified = { subject: 'Template', body: 'Generic body', tokensUsed: 0, verdicts: [], failedVerdict: false, judgeUnavailable: false }

    const response = await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    const body = await response.json()

    expect(body.usedLlm).toBe(false)
    expect(insertOutreachMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ used_llm: false }))
  })

  it('records a model draft as used_llm:true', async () => {
    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    expect(insertOutreachMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ used_llm: true }))
  })
})

describe('POST, what the Langfuse trace says', () => {
  it('the root input is the job title and company, not raw ids, and the ids ride the trace metadata', async () => {
    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    expect(traced.input).toEqual([{ jobTitle: 'Staff Engineer', companyName: 'Acme' }])
    expect(traced.meta[0]).toEqual({ contact_id: 'contact-1', job_id: 'job-1' })
    expect(traced.output[0]).toMatchObject({ subject: 'Hi', usedLlm: true })
  })

  it.each([
    ['no judge key (the judge refused, nothing was recorded)', { verdicts: [], judgeUnavailable: false }, 'skipped'],
    ['the judge ran', { verdicts: [{ name: 'outreach groundedness', verdict: 'pass', score: 0.9, threshold: 0.5, summary: 's' }], judgeUnavailable: false }, 'ran'],
    ['the judge failed unexpectedly', { verdicts: [], judgeUnavailable: true }, 'failed'],
  ])('says whether the draft was judged: %s', async (_label, fixture, expected) => {
    verified = { subject: 'Hi', body: 'Draft body', tokensUsed: 10, failedVerdict: false, ...fixture }
    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    expect(traced.output[0]).toMatchObject({ judge: expected })
    expect(traced.meta).toContainEqual({ message_id: 'msg-1', judge: expected })
  })
})
