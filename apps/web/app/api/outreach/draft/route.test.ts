// Tests for POST /api/outreach/draft. Two contracts matter most:
//  - a broken judge (a raw 402, a missing key) must never take the draft down:
//    insertOutreach() runs and the draft persists 'pending_review' whatever the
//    review stage does;
//  - a draft is never signed with a guessed name, and a template is recorded as
//    one, with the reason, so the card can say so.
// Everything below verifyOutreachDraft is mocked (the review's own control flow is
// lib/graph/verify/outreach.test.ts's job); the verdict rows go through the real
// writeReviewVerdicts into a mocked writeVerdict.

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
  output: { subject: 'Hi', body: 'Draft body', tokensUsed: 10, source: 'model' },
  tokensUsed: 10,
}))
vi.mock('@/lib/graph/oneshot', () => ({
  runUnitOnce: (...args: unknown[]) => runUnitOnceMock(...args),
}))

const PASSING_CHECKS = { ok: true, checks: [{ id: 'one_ask', ok: true, message: 'One ask' }] }
interface ReviewFixture {
  subject: string
  body: string
  tokensUsed: number
  source: 'model' | 'template'
  templateReason?: string
  verdicts: unknown[]
  checks: { ok: boolean; checks: { id: string; ok: boolean; message: string }[] }
  failed: boolean
  judgeUnavailable: boolean
  judgeRefused?: 'missing-key' | 'budget-cap'
}
let review: ReviewFixture
const verifyOutreachDraftMock = vi.fn(async (..._args: unknown[]) => review)
vi.mock('@/lib/graph/verify/outreach', () => ({
  verifyOutreachDraft: (...args: unknown[]) => verifyOutreachDraftMock(...args),
}))

let senderName: string | null
const loadOutreachSourcesMock = vi.fn(async (..._args: unknown[]) => ({
  senderName,
  companyId: 'co-1',
  hasHistory: false,
  input: {
    userEmail: 'alex@example.com',
    jobTitle: 'Staff Engineer',
    companyName: 'Acme',
    resumeText: 'Senior engineer.',
    matchHighlights: [],
    jobDescription: 'Build things.',
    facts: [],
    history: [],
    patterns: [],
  },
}))
vi.mock('@/lib/outreach/sources', () => ({
  loadOutreachSources: (...args: unknown[]) => loadOutreachSourcesMock(...args),
}))

const writeVerdictMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/evals/verdicts', () => ({
  writeVerdict: (...args: unknown[]) => writeVerdictMock(...args),
}))

const recordDemoEventMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/access/session', () => ({
  recordDemoEvent: (...args: unknown[]) => recordDemoEventMock(...args),
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

const modelReview = (over: Partial<ReviewFixture> = {}): ReviewFixture => ({
  subject: 'Hi',
  body: 'Draft body',
  tokensUsed: 10,
  source: 'model',
  verdicts: [],
  checks: PASSING_CHECKS,
  failed: false,
  judgeUnavailable: false,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  traced.input.length = traced.output.length = traced.meta.length = 0
  findDuplicateInitialMock.mockResolvedValue(null)
  writeVerdictMock.mockResolvedValue(undefined)
  user = { id: 'user-1', email: 'alex@example.com' }
  senderName = 'Alex Candidate'
  review = modelReview()
  insertOutreachMock.mockImplementation(async (_admin: unknown, row: Record<string, unknown>) => ({ id: 'msg-1', ...row }))
})

describe('POST, no name no draft', () => {
  it('answers 409 needsName before any model is called when the profile has no full name', async () => {
    senderName = null

    const response = await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toMatchObject({ needsName: true, error: 'Add your full name in Settings first. Drafts are signed with it.' })
    expect(runUnitOnceMock).not.toHaveBeenCalled()
    expect(insertOutreachMock).not.toHaveBeenCalled()
  })

  it('signs with the profile name, never the email local part', async () => {
    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    expect(runUnitOnceMock).toHaveBeenCalledWith('outreach', expect.objectContaining({ input: expect.objectContaining({ userName: 'Alex Candidate', kind: 'initial' }) }))
  })
})

describe('POST, a broken judge cannot take the draft down with it', () => {
  it('persists pending_review and returns 2xx when the review reports judgeUnavailable', async () => {
    review = modelReview({ judgeUnavailable: true })

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

  it('writes an unjudged row for both judges plus the code checks, keyed to the saved draft', async () => {
    review = modelReview({ judgeUnavailable: true })

    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))

    for (const judge of ['groundedness', 'specificity']) {
      expect(writeVerdictMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ subjectKind: 'outreach_draft', subjectId: 'msg-1', judge, verdict: 'unjudged' })
      )
    }
    // A refusal never carries a substituted score.
    for (const call of writeVerdictMock.mock.calls.filter((c) => (c[1] as { verdict: string }).verdict === 'unjudged')) {
      expect((call[1] as { score?: number }).score).toBeUndefined()
    }
  })

  it.each([
    ['missing-key', 'Not checked: no OpenRouter key is set.'],
    ['budget-cap', 'Not checked: the spending cap is reached.'],
  ] as const)('says why the judges did not run (%s)', async (judgeRefused, reason) => {
    review = modelReview({ judgeRefused })

    const response = await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))

    expect(response.status).toBe(200)
    const unjudged = writeVerdictMock.mock.calls.map((c) => c[1] as { verdict: string; rationale: string }).filter((v) => v.verdict === 'unjudged')
    expect(unjudged).toHaveLength(2)
    for (const v of unjudged) expect(v.rationale).toBe(reason)
  })
})

describe('POST, the verdict rows', () => {
  it('writes groundedness, specificity and one deterministic row on the ordinary path', async () => {
    review = modelReview({
      verdicts: [
        { name: 'groundedness', verdict: 'pass', score: 1, threshold: 1, n: 3, summary: 'All 3 statements trace to your sources.' },
        { name: 'specificity', verdict: 'fail', score: 0, threshold: 1, n: 1, summary: 'Generic: nothing ties to the post.' },
      ],
      checks: { ok: false, checks: [{ id: 'one_ask', ok: false, message: '2 asks. Keep one so the reply is easy.' }] },
    })

    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))

    const rows = writeVerdictMock.mock.calls.map((c) => c[1] as { judge: string; verdict: string; rationale: string })
    expect(rows.map((r) => [r.judge, r.verdict])).toEqual([
      ['groundedness', 'pass'],
      ['specificity', 'fail'],
      ['deterministic', 'fail'],
    ])
    expect(rows[2].rationale).toBe('2 asks. Keep one so the reply is easy.')
  })

  it('writes only the deterministic row for a template, and "All checks passed" when they pass', async () => {
    review = modelReview({ source: 'template', templateReason: 'missing_key', tokensUsed: 0 })

    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))

    expect(writeVerdictMock).toHaveBeenCalledTimes(1)
    expect(writeVerdictMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ judge: 'deterministic', verdict: 'pass', rationale: 'All checks passed' }))
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

  it('stores a template as used_llm false with its reason, and reports it', async () => {
    review = modelReview({ source: 'template', templateReason: 'spend_cap', tokensUsed: 0 })

    const response = await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    const body = await response.json()

    expect(body).toMatchObject({ usedLlm: false, templateReason: 'spend_cap' })
    expect(insertOutreachMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ used_llm: false, template_reason: 'spend_cap' }))
  })

  it('a template whose model call spent tokens is still a template (unusable output)', async () => {
    review = modelReview({ source: 'template', templateReason: 'unusable_output', tokensUsed: 120 })
    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    expect(insertOutreachMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ used_llm: false, template_reason: 'unusable_output' }))
  })

  it('records a model draft as used_llm true with no reason', async () => {
    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    expect(insertOutreachMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ used_llm: true, template_reason: null }))
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
    ['the judge ran', { verdicts: [{ name: 'groundedness', verdict: 'pass', score: 1, threshold: 1, summary: 's' }], judgeUnavailable: false }, 'ran'],
    ['the judge failed unexpectedly', { verdicts: [], judgeUnavailable: true }, 'failed'],
  ])('says whether the draft was judged: %s', async (_label, fixture, expected) => {
    review = modelReview(fixture)
    await POST(post({ contactId: 'contact-1', jobId: 'job-1' }))
    expect(traced.output[0]).toMatchObject({ judge: expected })
    expect(traced.meta).toContainEqual({ message_id: 'msg-1', judge: expected })
  })
})
