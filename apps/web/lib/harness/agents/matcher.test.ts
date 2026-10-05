// Tests for lib/harness/agents/matcher.ts: the background door onto lib/scoring.
//
// What matters here is what the matcher no longer does: it writes no score, and it
// creates no application on its own (a role reaches Pipeline when the person taps
// Interested). It hands the work to lib/scoring and reports what came back.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient, StepContext } from '../types'
import { MissingKeyError } from '../llm'
import type { RoleFit } from '@/lib/scoring/types'

const assessJobs = vi.fn()
const runDailyShortlist = vi.fn()
vi.mock('@/lib/scoring', () => ({
  assessJobs: (...a: unknown[]) => assessJobs(...a),
  runDailyShortlist: (...a: unknown[]) => runDailyShortlist(...a),
}))

const { scoreJobBatch, matcher, diagnoseCandidateJobs } = await import('./matcher')

const LLM = vi.fn()

function fit(jobId: string, over: Partial<RoleFit> = {}): RoleFit {
  return {
    jobId,
    assessedAt: '2026-10-06T08:00:00Z',
    blocked: [],
    want: { p: 0.7, reason: 'Payments work like what you liked.', tier: 'high', calibrated: false, nReactions: 4 },
    chance: {
      label: 'possible',
      checks: [
        { requirement: '4+ years backend', mustHave: true, status: 'met', evidence: { line: 3, quote: 'Backend engineer, Brightpay, 2020-2024' } },
        { requirement: 'Kubernetes', mustHave: false, status: 'not_met', evidence: null },
      ],
      gaps: ['Nice to have: Kubernetes'],
      confirm: [],
      note: null,
    },
    ...over,
  }
}

function assessed(fits: RoleFit[], over: Record<string, unknown> = {}) {
  return { assessed: fits.filter((f) => f.blocked.length === 0).length, blocked: fits.filter((f) => f.blocked.length > 0).length, failed: 0, remaining: 3, fits: new Map(fits.map((f) => [f.jobId!, f])), ...over }
}

/** An admin client that fails the test if the matcher writes to it. */
const NO_WRITES = new Proxy({}, { get: () => () => { throw new Error('the matcher must not write') } }) as unknown as AdminClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scoreJobBatch', () => {
  it('hands the work to the scoring system and reports chance, want and cited highlights, never a score', async () => {
    assessJobs.mockResolvedValue(assessed([fit('j1')]))
    const out = await scoreJobBatch({ admin: NO_WRITES, userId: 'u', llm: LLM, limit: 25 })
    expect(assessJobs).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', limit: 25, llm: LLM }))
    expect(out.scored).toEqual([
      { jobId: 'j1', blocked: [], chance: 'possible', want: 0.7, wantReason: 'Payments work like what you liked.', highlights: ['4+ years backend: Backend engineer, Brightpay, 2020-2024'], gaps: ['Nice to have: Kubernetes'] },
    ])
    expect(out.scored[0]).not.toHaveProperty('score')
    expect(out.remaining).toBe(3)
  })

  it('reports a filtered role with the stated fact it breaks', async () => {
    const blocked = fit('j2', { blocked: [{ kind: 'location', text: 'It is based in Germany, and you said you work in the United States.' }], want: null, chance: null })
    assessJobs.mockResolvedValue(assessed([blocked]))
    const out = await scoreJobBatch({ admin: NO_WRITES, userId: 'u', llm: LLM, limit: 5 })
    expect(out.blockedCount).toBe(1)
    expect(out.scored[0]).toMatchObject({ jobId: 'j2', blocked: ['It is based in Germany, and you said you work in the United States.'], chance: null, want: null })
  })

  it('passes a reason for doing nothing through, and never fails silently', async () => {
    assessJobs.mockResolvedValue({ assessed: 0, blocked: 0, failed: 0, remaining: 0, skippedReason: 'no-resume', fits: new Map() })
    expect((await scoreJobBatch({ admin: NO_WRITES, userId: 'u', llm: LLM, limit: 5 })).skippedReason).toBe('no-resume')
    assessJobs.mockResolvedValue({ assessed: 0, blocked: 0, failed: 4, remaining: 4, fits: new Map() })
    expect((await scoreJobBatch({ admin: NO_WRITES, userId: 'u', llm: LLM, limit: 5 })).skippedReason).toBe('all 4 assessment(s) failed')
  })

  it('maps a missing key to a reason instead of throwing, and lets other errors through', async () => {
    assessJobs.mockRejectedValue(new MissingKeyError('no key'))
    expect((await scoreJobBatch({ admin: NO_WRITES, userId: 'u', llm: LLM, limit: 5 })).skippedReason).toBe('no-llm-key')
    assessJobs.mockRejectedValue(new Error('database down'))
    await expect(scoreJobBatch({ admin: NO_WRITES, userId: 'u', llm: LLM, limit: 5 })).rejects.toThrow('database down')
  })

  it('does nothing when already aborted', async () => {
    const c = new AbortController()
    c.abort()
    const out = await scoreJobBatch({ admin: NO_WRITES, userId: 'u', llm: LLM, limit: 5, signal: c.signal })
    expect(out.skippedReason).toBe('aborted')
    expect(assessJobs).not.toHaveBeenCalled()
  })
})

describe('matcher step', () => {
  const ctx = (input: unknown = {}, deps: Record<string, unknown> = {}) =>
    ({ userId: 'u', input, deps, admin: NO_WRITES, apiKeys: { openrouter: 'k' }, llm: LLM, signal: new AbortController().signal }) as unknown as StepContext

  it('assesses, picks the day\'s list once, and creates no application', async () => {
    assessJobs.mockResolvedValue(assessed([fit('j1'), fit('j2', { chance: { label: 'strong', checks: [], gaps: [], confirm: [], note: null } })]))
    runDailyShortlist.mockResolvedValue({ status: 'ok', picks: [{ jobId: 'j2' }, { jobId: 'j1' }] })
    const out = await matcher(ctx())
    expect(runDailyShortlist).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', skipIfBuilt: true }))
    const o = out.output as { matches: { jobId: string; chance: string; want: number }[]; topJobIds: string[] }
    expect(o.matches.map((m) => [m.jobId, m.chance])).toEqual([['j1', 'possible'], ['j2', 'strong']])
    expect(o.matches.every((m) => m.want > 0 && m.want <= 1)).toBe(true)
    expect(o.topJobIds).toEqual(['j2', 'j1'])
  })

  it('assesses exactly the roles a dependency step found', async () => {
    assessJobs.mockResolvedValue(assessed([fit('a')]))
    runDailyShortlist.mockResolvedValue({ status: 'ok', picks: [] })
    await matcher(ctx({ jobIds: ['a'] }, { sourcer: { jobIds: ['b'] } }))
    expect(assessJobs).toHaveBeenCalledWith(expect.objectContaining({ jobIds: expect.arrayContaining(['a', 'b']) }))
  })

  it('does not pick a list when assessing could not run', async () => {
    assessJobs.mockResolvedValue({ assessed: 0, blocked: 0, failed: 0, remaining: 0, skippedReason: 'no-resume', fits: new Map() })
    const out = await matcher(ctx())
    expect(runDailyShortlist).not.toHaveBeenCalled()
    expect((out.output as { skippedReason: string }).skippedReason).toBe('no-resume')
  })
})

describe('diagnoseCandidateJobs', () => {
  it('says which requested roles will be assessed and explains the ones that will not', async () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: async () => ({ data: [{ id: 'a', title: 'Backend Engineer', description: 'x' }, { id: 'b', title: 'Designer', description: '' }], error: null }),
    }
    const admin = { from: () => chain } as unknown as AdminClient
    const out = await diagnoseCandidateJobs(admin, ['a', 'b', 'c'], 'u')
    expect(out).toEqual([
      { jobId: 'a', title: 'Backend Engineer', found: true, hasDescription: true, willAttemptScoring: true, reason: null },
      { jobId: 'b', title: 'Designer', found: true, hasDescription: false, willAttemptScoring: true, reason: null },
      { jobId: 'c', title: null, found: false, hasDescription: false, willAttemptScoring: false, reason: "not found among your tracked companies' jobs" },
    ])
  })
})
