// Tests for lib/graph/verify/outreach.ts — ruling 2, item 2: groundedness +
// specificity, ONE bounded regeneration on failure, ALWAYS persists (never a
// containment-style fail-closed gate — see this module's own header).
// runUnitOnce/loadApiKeys/the two judges are all faked at the lowest level.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutreachDraftInput, OutreachDraftResult } from '../../harness/agents/outreach'

interface JudgeVerdict {
  name: string
  verdict: 'pass' | 'fail'
  score: number | null
  threshold: number
  n: number
  summary: string
}

type OutreachUnitResult = { output: OutreachDraftResult; tokensUsed: number }
const runUnitOnceMock = vi.fn<[unitType: string, args: unknown], Promise<OutreachUnitResult>>()
vi.mock('../oneshot', () => ({
  runUnitOnce: (...args: unknown[]) => (runUnitOnceMock as unknown as (...a: unknown[]) => Promise<OutreachUnitResult>)(...args),
}))

const loadApiKeysMock = vi.fn(async (): Promise<{ openrouter?: string }> => ({ openrouter: 'fake-key' }))
vi.mock('../../harness/keys', () => ({
  loadApiKeys: (...args: unknown[]) => (loadApiKeysMock as unknown as (...a: unknown[]) => ReturnType<typeof loadApiKeysMock>)(...args),
}))

const judgeGroundednessMock = vi.fn<[client: unknown, input: unknown, opts: unknown], Promise<JudgeVerdict>>()
const judgeSpecificityMock = vi.fn<[client: unknown, input: unknown, opts: unknown], Promise<JudgeVerdict>>()
vi.mock('../../evals/judge', () => ({
  meteredJudgeClient: vi.fn(() => ({})),
  judgeGroundedness: (...args: unknown[]) => (judgeGroundednessMock as unknown as (...a: unknown[]) => Promise<JudgeVerdict>)(...args),
  judgeSpecificity: (...args: unknown[]) => (judgeSpecificityMock as unknown as (...a: unknown[]) => Promise<JudgeVerdict>)(...args),
}))

const logHarnessErrorMock = vi.fn()
vi.mock('../../observability/log', () => ({
  logHarnessError: (...args: unknown[]) => logHarnessErrorMock(...args),
}))

const { verifyOutreachDraft } = await import('./outreach')
const { MissingKeyError } = await import('../../harness/llm')
const { BudgetCapError } = await import('../../harness/spend')

function pass(name: string): JudgeVerdict {
  return { name, verdict: 'pass', score: 0.9, threshold: 0.5, n: 1, summary: 'grounded and specific' }
}
function fail(name: string): JudgeVerdict {
  return { name, verdict: 'fail', score: 0.1, threshold: 0.5, n: 1, summary: `${name} flagged this` }
}

const input: OutreachDraftInput = {
  userName: 'Alex',
  userEmail: 'alex@example.com',
  jobTitle: 'Staff Engineer',
  companyName: 'Acme',
  resumeText: 'Senior engineer with 8 years of Go.',
  jobDescription: 'Build things.',
}
const draft: OutreachDraftResult = { subject: 'Hello', body: 'Original body', tokensUsed: 20 }

function baseArgs() {
  return { admin: {} as never, userId: 'user-1', goal: 'test', input, draft }
}

beforeEach(() => {
  vi.clearAllMocks()
  loadApiKeysMock.mockResolvedValue({ openrouter: 'fake-key' })
})

describe('verifyOutreachDraft — happy path', () => {
  it('returns the original draft unchanged when both judges pass, no regeneration', async () => {
    judgeGroundednessMock.mockResolvedValue(pass('outreach groundedness'))
    judgeSpecificityMock.mockResolvedValue(pass('outreach specificity'))

    const result = await verifyOutreachDraft(baseArgs())
    expect(result.body).toBe('Original body')
    expect(result.failedVerdict).toBe(false)
    expect(result.verdicts).toHaveLength(2)
    expect(runUnitOnceMock).not.toHaveBeenCalled()
  })
})

describe('verifyOutreachDraft — ONE bounded regeneration on failure', () => {
  it('regenerates once when a verdict fails, and returns the regenerated content + final verdicts', async () => {
    judgeGroundednessMock.mockResolvedValueOnce(fail('outreach groundedness')).mockResolvedValueOnce(pass('outreach groundedness'))
    judgeSpecificityMock.mockResolvedValue(pass('outreach specificity'))
    runUnitOnceMock.mockResolvedValue({
      output: { subject: 'Regenerated subject', body: 'Regenerated body', tokensUsed: 15 },
      tokensUsed: 15,
    })

    const result = await verifyOutreachDraft(baseArgs())
    expect(result.body).toBe('Regenerated body')
    expect(result.failedVerdict).toBe(false)
    expect(result.tokensUsed).toBe(35) // 20 original + 15 regenerated
    expect(runUnitOnceMock).toHaveBeenCalledTimes(1) // bounded to ONE regeneration
    const regenCall = runUnitOnceMock.mock.calls[0][1] as { input: { correctiveContext?: string } }
    expect(regenCall.input.correctiveContext).toContain('groundedness flagged this')
  })

  it('still persists a still-failing draft after the one regeneration, flagged failedVerdict:true', async () => {
    judgeGroundednessMock.mockResolvedValue(fail('outreach groundedness'))
    judgeSpecificityMock.mockResolvedValue(pass('outreach specificity'))
    runUnitOnceMock.mockResolvedValue({
      output: { subject: 'Regenerated subject', body: 'Regenerated body', tokensUsed: 15 },
      tokensUsed: 15,
    })

    const result = await verifyOutreachDraft(baseArgs())
    expect(result.body).toBe('Regenerated body') // NEVER blocks persistence
    expect(result.failedVerdict).toBe(true)
    expect(runUnitOnceMock).toHaveBeenCalledTimes(1) // still bounded, no infinite loop
  })
})

describe('verifyOutreachDraft — judge unavailable', () => {
  it('a budget-cap refusal returns the original draft with empty verdicts, never a crash', async () => {
    judgeGroundednessMock.mockRejectedValue(new BudgetCapError(12, 10))

    const result = await verifyOutreachDraft(baseArgs())
    expect(result.body).toBe('Original body')
    expect(result.verdicts).toEqual([])
    expect(result.failedVerdict).toBe(false)
  })

  it('a missing judge key returns the original draft with empty verdicts', async () => {
    judgeGroundednessMock.mockImplementation(() => {
      throw new MissingKeyError('no key')
    })

    const result = await verifyOutreachDraft(baseArgs())
    expect(result.verdicts).toEqual([])
  })
})

describe('verifyOutreachDraft — a broke judge cannot take the draft down', () => {
  it('an unexpected judge error (e.g. a raw OpenRouter 402) never throws: the draft still persists, unjudged, logged', async () => {
    judgeGroundednessMock.mockRejectedValue(new Error('402 Payment Required'))
    judgeSpecificityMock.mockResolvedValue(pass('outreach specificity'))

    const result = await verifyOutreachDraft(baseArgs())

    expect(result.body).toBe('Original body') // NEVER blocks persistence
    expect(result.verdicts).toEqual([])
    expect(result.failedVerdict).toBe(false)
    expect(result.judgeUnavailable).toBe(true)
    expect(logHarnessErrorMock).toHaveBeenCalledTimes(1)
    const [ctx] = logHarnessErrorMock.mock.calls[0] as [Record<string, unknown>]
    expect(ctx).toMatchObject({ agentType: 'outreach', phase: 'judge' })
  })

  it('the same unexpected-error discipline applies to the post-regeneration judge call', async () => {
    judgeGroundednessMock.mockResolvedValueOnce(fail('outreach groundedness')).mockRejectedValueOnce(new Error('boom'))
    judgeSpecificityMock.mockResolvedValue(pass('outreach specificity'))
    runUnitOnceMock.mockResolvedValue({
      output: { subject: 'Regenerated subject', body: 'Regenerated body', tokensUsed: 15 },
      tokensUsed: 15,
    })

    const result = await verifyOutreachDraft(baseArgs())

    expect(result.body).toBe('Regenerated body') // still the regenerated content
    expect(result.verdicts).toEqual([])
    expect(result.judgeUnavailable).toBe(true)
    expect(logHarnessErrorMock).toHaveBeenCalledTimes(1)
  })

  // MUTATION CHECK (executed, not left to trust): removed the non-refusal
  // catch above (reverted `throw err` in its place) — this test's first case
  // went red with an unhandled rejection ("402 Payment Required") instead of
  // a returned result, reproducing the E2E 500. Reverted immediately.
})
