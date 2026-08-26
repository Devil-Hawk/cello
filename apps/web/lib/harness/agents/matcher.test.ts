// Tests for lib/harness/agents/matcher.ts: scoreJobWithLlm's buildMatchContext
// wiring (langgraph port step 9), and verifyMatchVerdict's own writeVerdict /
// floor-before-spend / catch-branch integration (Step 4 item 3) — the real
// wired call site, not just lib/graph/verify/matcher.test.ts's pure-helper
// coverage of checkMatchVerdictDeterministic/needsJudgeSample.
//
// CACHE-PREFIX STABILITY (matcher.ts's own CACHE STRUCTURE comment): the
// resume + rubric live in `system` with cachePrefix:true because they are
// byte-identical across every job a user scores — that only bills at a
// fraction of full price if the provider's cache actually hits, which
// requires `system` to be byte-for-byte unchanged call to call. buildMatchContext
// is per-COMPANY, so it must never leak into `system` — this file proves that
// directly against the real function, not by trusting the comment.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../types'
import type { LlmRunOptions, LlmResult } from '../types'
import { EMPTY_TARGETING } from '@/lib/targeting'
import { BudgetCapError } from '@/lib/harness/spend'
import { MissingKeyError } from '../llm'
import type { ScoreBatchOptions, LlmVerdict } from './matcher'
import type { EvalResult } from '@/lib/evals/harness'

vi.mock('@/lib/context/assemble', () => ({
  buildMatchContext: vi.fn(async (_admin: unknown, _userId: string, companyId: string | null) =>
    companyId ? `CONTEXT FOR ${companyId}` : ''
  ),
}))

const judgeMatchQualityMock = vi.fn<[unknown, unknown, unknown], Promise<EvalResult>>()
vi.mock('@/lib/evals/judge', () => ({
  meteredJudgeClient: vi.fn(() => ({})),
  judgeMatchQuality: (client: unknown, input: unknown, opts: unknown) => judgeMatchQualityMock(client, input, opts),
}))

const logHarnessErrorMock = vi.fn()
vi.mock('@/lib/observability/log', () => ({
  logHarnessError: (...args: unknown[]) => logHarnessErrorMock(...args),
}))

const { scoreJobWithLlm, verifyMatchVerdict } = await import('./matcher')

const FAKE_ADMIN = {} as AdminClient

function fakeLlm(calls: LlmRunOptions[]) {
  return async (opts: LlmRunOptions): Promise<LlmResult> => {
    calls.push(opts)
    return {
      content: JSON.stringify({ score: 80 }),
      tokensUsed: 100,
      promptTokens: 90,
      completionTokens: 10,
      model: 'fake/test-model',
    }
  }
}

const RESUME = 'Experienced backend engineer.'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scoreJobWithLlm — buildMatchContext wiring', () => {
  it('interpolates buildMatchContext into `prompt`, never into `system` — the cached prefix stays byte-identical across companies', async () => {
    const calls: LlmRunOptions[] = []
    const llm = fakeLlm(calls)

    await scoreJobWithLlm(
      llm,
      RESUME,
      { id: 'job-1', title: 'Backend Engineer', description: 'Do the work.', location: 'Remote', companyId: 'company-a' },
      FAKE_ADMIN,
      'user-1'
    )
    await scoreJobWithLlm(
      llm,
      RESUME,
      { id: 'job-2', title: 'Backend Engineer', description: 'Do the work.', location: 'Remote', companyId: 'company-b' },
      FAKE_ADMIN,
      'user-1'
    )

    expect(calls).toHaveLength(2)
    // The cached prefix: byte-identical for the same resume regardless of company.
    expect(calls[0]!.system).toBe(calls[1]!.system)
    expect(calls[0]!.system).not.toContain('CONTEXT FOR')

    // The per-company context lands in `prompt`, and differs company to company.
    expect(calls[0]!.prompt).toContain('CONTEXT FOR company-a')
    expect(calls[1]!.prompt).toContain('CONTEXT FOR company-b')
    expect(calls[0]!.prompt).not.toBe(calls[1]!.prompt)
  })

  it('adds no context block when the job has no company', async () => {
    const calls: LlmRunOptions[] = []
    const llm = fakeLlm(calls)
    await scoreJobWithLlm(
      llm,
      RESUME,
      { id: 'job-3', title: 'Backend Engineer', description: 'Do the work.', location: 'Remote', companyId: null },
      FAKE_ADMIN,
      'user-1'
    )
    expect(calls[0]!.prompt).not.toContain('CONTEXT FOR')
  })
})

// --- verifyMatchVerdict — Step 4 item 3's real wired integration -----------

class FakeVerdictAdmin {
  inserted: Record<string, unknown>[] = []
  from(table: string) {
    if (table !== 'eval_verdicts') throw new Error(`FakeVerdictAdmin: unexpected table "${table}"`)
    return {
      insert: (row: Record<string, unknown>) => {
        this.inserted.push(row)
        return Promise.resolve({ error: null })
      },
    }
  }
}

const GOOD_VERDICT: LlmVerdict = {
  score: 80,
  skillsMatch: 80,
  experienceMatch: 80,
  locationMatch: 80,
  strengths: ['Backend experience'],
  gaps: [],
  seniorityFit: 'Senior',
  summary: 'Strong match.',
  matchedSkills: ['backend'],
  missingSkills: [],
}

function baseOpts(overrides: Partial<ScoreBatchOptions> = {}): ScoreBatchOptions {
  return {
    admin: new FakeVerdictAdmin() as unknown as AdminClient,
    userId: 'user-1',
    companyIds: [],
    resume: RESUME,
    targeting: EMPTY_TARGETING,
    llm: fakeLlm([]),
    limit: 1,
    ...overrides,
  }
}

describe('verifyMatchVerdict — writeVerdict / floor-before-spend / catch branches', () => {
  beforeEach(() => {
    judgeMatchQualityMock.mockReset()
    logHarnessErrorMock.mockReset()
  })

  it('always writes the deterministic postcondition, and skips the judge without a key (floor before spend)', async () => {
    const opts = baseOpts() // no apiKeys at all
    await verifyMatchVerdict(opts, 'job-1', GOOD_VERDICT, 'framed job text mentioning Backend experience')

    const admin = opts.admin as unknown as FakeVerdictAdmin
    expect(admin.inserted).toHaveLength(1)
    expect(admin.inserted[0]).toMatchObject({ judge: 'deterministic', verdict: 'pass', subject_id: 'job-1' })
    expect(judgeMatchQualityMock).not.toHaveBeenCalled()
  })

  it('writes a failing deterministic verdict for fabricated evidence, still without touching the judge', async () => {
    const opts = baseOpts()
    const fabricated: LlmVerdict = { ...GOOD_VERDICT, gaps: ['Ten years of quantum computing experience'] }
    await verifyMatchVerdict(opts, 'job-2', fabricated, 'framed job text mentioning Backend experience')

    const admin = opts.admin as unknown as FakeVerdictAdmin
    expect(admin.inserted).toHaveLength(1)
    expect(admin.inserted[0].judge).toBe('deterministic')
    expect(admin.inserted[0].verdict).toBe('fail')
  })

  it('samples a threshold-crossing score and persists a passing closed_qa verdict', async () => {
    judgeMatchQualityMock.mockResolvedValueOnce({
      name: 'match quality',
      verdict: 'pass',
      score: 0.9,
      threshold: 0.7,
      n: 1,
      summary: 'Internally consistent.',
    })
    const opts = baseOpts({ apiKeys: { openrouter: 'fake-key' } as never, judgeThreshold: 50, runId: 'run-1' })
    await verifyMatchVerdict(opts, 'job-3', GOOD_VERDICT, 'framed job text mentioning Backend experience')

    const admin = opts.admin as unknown as FakeVerdictAdmin
    expect(admin.inserted).toHaveLength(2)
    expect(admin.inserted[1]).toMatchObject({ judge: 'closed_qa', verdict: 'pass', run_id: 'run-1' })
    expect(judgeMatchQualityMock).toHaveBeenCalledTimes(1)
  })

  it('judge budget-refusal writes a typed unjudged verdict, never a substituted score (invariant 7)', async () => {
    judgeMatchQualityMock.mockRejectedValueOnce(new BudgetCapError(10, 10))
    const opts = baseOpts({ apiKeys: { openrouter: 'fake-key' } as never, judgeThreshold: 50 })
    await verifyMatchVerdict(opts, 'job-4', GOOD_VERDICT, 'framed job text mentioning Backend experience')

    const admin = opts.admin as unknown as FakeVerdictAdmin
    expect(admin.inserted).toHaveLength(2)
    expect(admin.inserted[1]).toMatchObject({ judge: 'closed_qa', verdict: 'unjudged' })
    expect(logHarnessErrorMock).not.toHaveBeenCalled() // an expected refusal, not a failure worth an operator's attention
  })

  it('judge missing-key refusal writes unjudged the same way as a budget refusal', async () => {
    judgeMatchQualityMock.mockRejectedValueOnce(new MissingKeyError('no key'))
    const opts = baseOpts({ apiKeys: { openrouter: 'fake-key' } as never, judgeThreshold: 50 })
    await verifyMatchVerdict(opts, 'job-5', GOOD_VERDICT, 'framed job text mentioning Backend experience')

    const admin = opts.admin as unknown as FakeVerdictAdmin
    expect(admin.inserted[1]).toMatchObject({ judge: 'closed_qa', verdict: 'unjudged' })
  })

  it('an unexpected judge failure never throws and never writes a row silently — it logs via logHarnessError', async () => {
    judgeMatchQualityMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    const opts = baseOpts({ apiKeys: { openrouter: 'fake-key' } as never, judgeThreshold: 50, runId: 'run-9' })
    await expect(verifyMatchVerdict(opts, 'job-6', GOOD_VERDICT, 'framed job text mentioning Backend experience')).resolves.toBeUndefined()

    const admin = opts.admin as unknown as FakeVerdictAdmin
    // No closed_qa row — an unexpected failure isn't a typed refusal, it's a
    // real problem an operator needs to see, not a fabricated verdict row.
    expect(admin.inserted).toHaveLength(1)
    expect(admin.inserted[0].judge).toBe('deterministic')
    expect(logHarnessErrorMock).toHaveBeenCalledTimes(1)
    const [ctx, err] = logHarnessErrorMock.mock.calls[0] as [Record<string, unknown>, Error]
    expect(ctx).toMatchObject({ runId: 'run-9', agentType: 'matcher', phase: 'judge', userId: 'user-1' })
    expect(err.message).toBe('ECONNRESET')
  })

  it('does not sample a below-threshold score outside the deterministic 10%, and skips the judge entirely', async () => {
    // 'job-below-1' hashes outside shouldSampleForJudge's 10% window (FNV-1a
    // is deterministic — computed directly, not asserted against another
    // file's fixtures) and GOOD_VERDICT.score (80) sits below a threshold of
    // 95, so neither of needsJudgeSample's two ways in fires.
    const opts = baseOpts({ apiKeys: { openrouter: 'fake-key' } as never, judgeThreshold: 95 })
    await verifyMatchVerdict(opts, 'job-below-1', GOOD_VERDICT, 'framed job text mentioning Backend experience')

    const admin = opts.admin as unknown as FakeVerdictAdmin
    expect(admin.inserted).toHaveLength(1)
    expect(judgeMatchQualityMock).not.toHaveBeenCalled()
  })
})
