// Proves bulk_matcher's per-role outcome reporting on top of the scoring system:
// a role with no description is still assessed (never silently dropped) and says
// in plain language that its chance cannot be checked yet; a role that breaks a
// stated fact comes back blocked with that fact; a role that could not be
// assessed is reported as such so the next call picks it up again.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient, LlmRunner } from '../types'

const scoreJobBatch = vi.fn()
vi.mock('./matcher', () => ({ scoreJobBatch: (...a: unknown[]) => scoreJobBatch(...a) }))

const { runBulkMatch } = await import('./bulk_matcher')

const ADMIN = {} as AdminClient
const LLM: LlmRunner = vi.fn()

const base = { admin: ADMIN, userId: 'u', llm: LLM, limit: 5 }
const row = (over: Record<string, unknown> = {}) => ({ jobId: 'j1', blocked: [], chance: 'possible', want: 0.6, wantReason: 'Payments work like what you liked.', highlights: [], gaps: [], ...over })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runBulkMatch', () => {
  it('reports why a role with no description cannot have its chance checked, instead of a bare "failed"', async () => {
    scoreJobBatch.mockResolvedValue({ scored: [row({ chance: 'cannot_assess', wantReason: null })], blockedCount: 0, failedCount: 0, candidatesConsidered: 1, remaining: 0 })
    const result = await runBulkMatch({ ...base, jobIds: ['j1'] })
    expect(result.scored).toBe(1)
    expect(result.failed).toBe(0)
    const o = result.jobOutcomes[0]
    expect(o).toMatchObject({ jobId: 'j1', status: 'assessed', chance: 'cannot_assess', titleOnly: true })
    expect(o.reason).toMatch(/does not list requirements/i)
    expect(o.reason).not.toMatch(/^failed$/i)
  })

  it('keeps the reason for a role with a description in the person\'s terms', async () => {
    scoreJobBatch.mockResolvedValue({ scored: [row()], blockedCount: 0, failedCount: 0, candidatesConsidered: 1, remaining: 0 })
    const o = (await runBulkMatch(base)).jobOutcomes[0]
    expect(o).toMatchObject({ status: 'assessed', chance: 'possible', titleOnly: false, reason: 'Payments work like what you liked.' })
    expect(o).not.toHaveProperty('score')
    expect(o).not.toHaveProperty('tier')
  })

  it('reports a filtered role with the stated fact it breaks', async () => {
    scoreJobBatch.mockResolvedValue({ scored: [row({ blocked: ['You ruled out Coinbase.'], chance: null, want: null, wantReason: null })], blockedCount: 1, failedCount: 0, candidatesConsidered: 1, remaining: 0 })
    const o = (await runBulkMatch(base)).jobOutcomes[0]
    expect(o).toEqual({ jobId: 'j1', status: 'blocked', chance: null, reason: 'You ruled out Coinbase.', titleOnly: false })
  })

  it('returns the reason and no outcomes when nothing could run', async () => {
    scoreJobBatch.mockResolvedValue({ scored: [], blockedCount: 0, failedCount: 0, candidatesConsidered: 0, remaining: 0, skippedReason: 'no-resume' })
    const result = await runBulkMatch(base)
    expect(result).toMatchObject({ scored: 0, failed: 0, skippedReasons: { 'no-resume': 1 }, batches: 0, jobOutcomes: [] })
  })

  it('applies a model override to every call and passes the keys through for the taste similarity', async () => {
    scoreJobBatch.mockResolvedValue({ scored: [], blockedCount: 0, failedCount: 0, candidatesConsidered: 0, remaining: 0, skippedReason: 'no-roles' })
    const inner = vi.fn(async () => ({ content: '{}', tokensUsed: 0, promptTokens: 0, completionTokens: 0, model: 'm' }))
    await runBulkMatch({ ...base, llm: inner, model: 'some/model', apiKeys: { openrouter: 'k' } })
    const passed = scoreJobBatch.mock.calls[0][0] as { llm: LlmRunner; apiKeys: unknown }
    await passed.llm({ prompt: 'x' })
    expect(inner).toHaveBeenCalledWith(expect.objectContaining({ model: 'some/model' }))
    expect(passed.apiKeys).toEqual({ openrouter: 'k' })
  })
})
