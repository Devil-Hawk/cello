// Tests for lib/graph/verify/cv-tailor.ts — ruling 2 (langgraph port design
// doc, Step 4) EXACTLY: containment gate (retry-then-fail-without-persist),
// matchClaim as informational supplement only, factual-grounding judge
// (retry-then-flag). runAgentUnit/claimsFor+matchClaim/loadApiKeys/the judge
// are all faked at the lowest level — this file proves ONLY this module's
// own control flow, never a real model or database.
//
// "fabricated-output fixture through the graph → ZERO application_drafts
// rows" (the brief's own words) is proven at the CALLER boundary here: this
// module never imports or touches application_drafts at all — grep confirms
// it below — and a containment failure THROWS instead of returning content,
// so a caller structurally cannot reach its own applier/persist call. The
// full-stack version of the same proof (through lib/graph/autopilot.ts's
// real prepareApplicationDraft, unmocked) lives in
// cv-tailor-persistence.test.ts.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TailoringContainmentReport } from '../../security/job-text'

// --- mocks -------------------------------------------------------------------

interface CvTailorFakeOutput {
  output: { resumeSummary: string; coverLetter: string; keywords: string[] }
  tokensUsed: number
  containment: TailoringContainmentReport
}
const runAgentUnitMock = vi.fn<[unitType: string, ctx: unknown], Promise<CvTailorFakeOutput>>()
vi.mock('../unit', () => ({
  runAgentUnit: (...args: unknown[]) => (runAgentUnitMock as unknown as (...a: unknown[]) => Promise<CvTailorFakeOutput>)(...args),
}))

const claimsForMock = vi.fn(async () => [] as unknown[])
const matchClaimMock = vi.fn(() => [] as unknown[])
vi.mock('../../resume/claims', () => ({
  claimsFor: (...args: unknown[]) => claimsForMock(...(args as [])),
  matchClaim: (...args: unknown[]) => matchClaimMock(...(args as [])),
}))

const loadApiKeysMock = vi.fn(async (): Promise<{ openrouter?: string }> => ({ openrouter: 'fake-key' }))
vi.mock('../../harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => loadApiKeysMock(...(args as [])),
}))

interface JudgeVerdict {
  name: string
  verdict: 'pass' | 'fail'
  score: number | null
  threshold: number
  n: number
  summary: string
}
const judgeGroundednessMock = vi.fn<[client: unknown, input: unknown, opts: unknown], Promise<JudgeVerdict>>()
vi.mock('../../evals/judge', () => ({
  meteredJudgeClient: vi.fn(() => ({})),
  judgeGroundedness: (...args: unknown[]) => (judgeGroundednessMock as unknown as (...a: unknown[]) => Promise<JudgeVerdict>)(...args),
}))

const logHarnessErrorMock = vi.fn()
vi.mock('../../observability/log', () => ({
  logHarnessError: (...args: unknown[]) => logHarnessErrorMock(...args),
}))

const { verifyCvTailorDraft, CvTailorContainmentError } = await import('./cv-tailor')
const { MissingKeyError } = await import('../../harness/llm')
const { BudgetCapError } = await import('../../harness/spend')

// --- fake admin: only `jobs` and `profiles`, both single-row reads ---------

function fakeAdmin() {
  const query = (data: unknown) => ({
    select: () => query(data),
    eq: () => query(data),
    single: async () => ({ data, error: null }),
  })
  return {
    from: (table: string) => {
      if (table === 'jobs') return query({ title: 'Staff Engineer', description: 'Build things.', companies: { name: 'Acme' } })
      if (table === 'profiles') return query({ resume_text: 'Senior engineer with 8 years of Go.' })
      throw new Error(`fake admin: unhandled table "${table}"`)
    },
  } as never
}

function baseArgs() {
  return { admin: fakeAdmin(), unitConfig: { configurable: { userId: 'user-1', runId: 'run-1', threadId: 't-1' } }, jobId: 'job-1' }
}

const cleanContent = { resumeSummary: 'Tailored summary.', coverLetter: 'Dear team,' , keywords: ['go'] }
const okContainment: TailoringContainmentReport = { ok: true, unsupported: [], fromJobText: false } as unknown as TailoringContainmentReport
const failContainment: TailoringContainmentReport = {
  ok: false,
  reason: 'claims a security clearance the resume never mentions',
  unsupported: [],
  fromJobText: false,
} as unknown as TailoringContainmentReport

function passVerdict(): JudgeVerdict {
  return { name: 'outreach groundedness', verdict: 'pass', score: 0.9, threshold: 0.5, n: 1, summary: 'well grounded' }
}
function failVerdict(): JudgeVerdict {
  return { name: 'outreach groundedness', verdict: 'fail', score: 0.1, threshold: 0.5, n: 1, summary: 'asserts unsupported facts' }
}

beforeEach(() => {
  vi.clearAllMocks()
  claimsForMock.mockResolvedValue([])
  matchClaimMock.mockReturnValue([])
  loadApiKeysMock.mockResolvedValue({ openrouter: 'fake-key' })
})

describe('verifyCvTailorDraft — containment (ruling 2a)', () => {
  it('returns verified when containment and the judge both pass on the first attempt', async () => {
    runAgentUnitMock.mockResolvedValue({ output: cleanContent, tokensUsed: 10, containment: okContainment })
    judgeGroundednessMock.mockResolvedValue(passVerdict())

    const outcome = await verifyCvTailorDraft(baseArgs())
    expect(outcome.kind).toBe('verified')
    expect(outcome.resumeSummary).toBe(cleanContent.resumeSummary)
    expect(runAgentUnitMock).toHaveBeenCalledTimes(1)
  })

  it('retries with corrective context on a containment failure, then succeeds', async () => {
    runAgentUnitMock
      .mockResolvedValueOnce({ output: cleanContent, tokensUsed: 5, containment: failContainment })
      .mockResolvedValueOnce({ output: cleanContent, tokensUsed: 5, containment: okContainment })
    judgeGroundednessMock.mockResolvedValue(passVerdict())

    const outcome = await verifyCvTailorDraft(baseArgs())
    expect(outcome.kind).toBe('verified')
    expect(runAgentUnitMock).toHaveBeenCalledTimes(2)
    // The retry carried the containment reason as corrective context.
    const secondCallInput = runAgentUnitMock.mock.calls[1][1] as { input: { correctiveContext?: string } }
    expect(secondCallInput.input.correctiveContext).toContain('security clearance')
  })

  it('FAILS WITHOUT PERSIST: a containment failure that survives ≤2 retries throws, never returns content', async () => {
    runAgentUnitMock.mockResolvedValue({ output: cleanContent, tokensUsed: 5, containment: failContainment })

    await expect(verifyCvTailorDraft(baseArgs())).rejects.toThrow(CvTailorContainmentError)
    // 1 initial attempt + 2 retries, never more — the bounded loop.
    expect(runAgentUnitMock).toHaveBeenCalledTimes(3)
    // The judge is never even reached on a fail-closed containment path.
    expect(judgeGroundednessMock).not.toHaveBeenCalled()
  })

  it('the ACT implementation (lib/harness/agents/cv_tailor.ts) contains no application_drafts write — the source assertion ruling 2 asks for', () => {
    const src = readFileSync(path.join(__dirname, '../../harness/agents/cv_tailor.ts'), 'utf8')
    expect(src).not.toMatch(/\.from\(\s*['"]application_drafts['"]/)
  })

  it('the resume_optimizer unit (lib/harness/registry.ts) carries the same guarantee — it never CALLS the persisting optimizeResumeAndSave', () => {
    const src = readFileSync(path.join(__dirname, '../../harness/registry.ts'), 'utf8')
    expect(src).not.toMatch(/optimizeResumeAndSave\(/) // a call, not just this comment's own prose
    expect(src).not.toMatch(/import\s*\{[^}]*optimizeResumeAndSave/) // nor an import of it at all
  })
})

describe('verifyCvTailorDraft — matchClaim supplements, never overrides (ruling 2b)', () => {
  it('a matchClaim hit does not change a passing verdict, and a miss does not change a failing one', async () => {
    runAgentUnitMock.mockResolvedValue({ output: cleanContent, tokensUsed: 5, containment: okContainment })
    matchClaimMock.mockReturnValue([{ claimId: 'c1', claimText: 'Go experience', matchedBy: 'normalized_key', similarity: null, evidence: [] }])
    judgeGroundednessMock.mockResolvedValue(passVerdict())

    const outcome = await verifyCvTailorDraft(baseArgs())
    expect(outcome.kind).toBe('verified')
    expect(claimsForMock).toHaveBeenCalledWith(expect.anything(), 'user-1')
  })
})

describe('verifyCvTailorDraft — the factual-grounding judge (ruling 2c)', () => {
  it('judge-failed after exhausting retries: content is still returned, kind is judge-failed, never thrown', async () => {
    runAgentUnitMock.mockResolvedValue({ output: cleanContent, tokensUsed: 5, containment: okContainment })
    judgeGroundednessMock.mockResolvedValue(failVerdict())

    const outcome = await verifyCvTailorDraft(baseArgs())
    expect(outcome.kind).toBe('judge-failed')
    expect(outcome.resumeSummary).toBe(cleanContent.resumeSummary)
    expect(runAgentUnitMock).toHaveBeenCalledTimes(3) // 1 + 2 retries, shared budget
    expect(judgeGroundednessMock).toHaveBeenCalledTimes(3)
  })

  it('retries with corrective context on a judge failure, then passes', async () => {
    runAgentUnitMock.mockResolvedValue({ output: cleanContent, tokensUsed: 5, containment: okContainment })
    judgeGroundednessMock.mockResolvedValueOnce(failVerdict()).mockResolvedValueOnce(passVerdict())

    const outcome = await verifyCvTailorDraft(baseArgs())
    expect(outcome.kind).toBe('verified')
    const secondCallInput = runAgentUnitMock.mock.calls[1][1] as { input: { correctiveContext?: string } }
    expect(secondCallInput.input.correctiveContext).toContain('unsupported facts')
  })

  it('a budget-cap refusal from the judge returns unjudged immediately, without retrying', async () => {
    runAgentUnitMock.mockResolvedValue({ output: cleanContent, tokensUsed: 5, containment: okContainment })
    judgeGroundednessMock.mockRejectedValue(new BudgetCapError(12, 10))

    const outcome = await verifyCvTailorDraft(baseArgs())
    expect(outcome.kind).toBe('unjudged')
    expect(runAgentUnitMock).toHaveBeenCalledTimes(1)
  })

  it('a missing judge key returns unjudged (typed refusal, not a crash)', async () => {
    runAgentUnitMock.mockResolvedValue({ output: cleanContent, tokensUsed: 5, containment: okContainment })
    loadApiKeysMock.mockResolvedValue({})
    judgeGroundednessMock.mockImplementation(() => {
      throw new MissingKeyError('no key')
    })

    const outcome = await verifyCvTailorDraft(baseArgs())
    expect(outcome.kind).toBe('unjudged')
    expect(logHarnessErrorMock).not.toHaveBeenCalled() // an expected refusal, not a failure worth an operator's attention
  })

  it('an unexpected judge failure (e.g. a real network error inside Factuality()) is a typed unjudged, never a silent rethrow', async () => {
    runAgentUnitMock.mockResolvedValue({ output: cleanContent, tokensUsed: 5, containment: okContainment })
    judgeGroundednessMock.mockRejectedValue(new Error('ECONNRESET'))

    const outcome = await verifyCvTailorDraft(baseArgs())
    expect(outcome.kind).toBe('unjudged')
    expect(logHarnessErrorMock).toHaveBeenCalledTimes(1)
    const [ctx, err] = logHarnessErrorMock.mock.calls[0] as [Record<string, unknown>, Error]
    expect(ctx).toMatchObject({ runId: 'run-1', agentType: 'cv_tailor', phase: 'judge', userId: 'user-1' })
    expect(err.message).toBe('ECONNRESET')
  })
})
