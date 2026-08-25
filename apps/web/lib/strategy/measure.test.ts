// Closes the loop lib/strategy/proposals.ts opens: once a proposal is
// accepted, did it help? These tests exist to prove the REFUSAL paths work at
// least as well as the happy path — a verdict rendered from an hour-old
// change or three new jobs would be noise dressed up as learning, so the
// gates that prevent that matter more than the arithmetic once past them.

import { describe, expect, it } from 'vitest'
import {
  MIN_MEANINGFUL_PASS_RATE_DELTA,
  MIN_NEW_JOBS_SAMPLE,
  MIN_OBSERVATION_WINDOW_HOURS,
  measureProposalEffect,
  recordAcceptedProposal,
  type AcceptedProposalRecord,
} from './measure'
import type { JobScopeCounts } from './datasource'

function counts(overrides: Partial<JobScopeCounts> = {}): JobScopeCounts {
  return {
    totalJobs: 100,
    totalPassingAllConfiguredFilters: 10, // 10% pass rate baseline
    jobsWithNoDescription: 0,
    excludedByDimension: {},
    excludedByKeywords: null,
    excludedByMinScoreHypothetical: null,
    ...overrides,
  }
}

const ACCEPTED_AT = new Date('2026-01-01T00:00:00.000Z')

function record(overrides: Partial<AcceptedProposalRecord> = {}): AcceptedProposalRecord {
  return { ...recordAcceptedProposal('filterImpact-1', 'filterImpact', 'Widen your seniority range.', counts(), ACCEPTED_AT), ...overrides }
}

function hoursAfter(hours: number): Date {
  return new Date(ACCEPTED_AT.getTime() + hours * 60 * 60 * 1000)
}

describe('recordAcceptedProposal', () => {
  it('captures the proposal identity, title, timestamp and before-snapshot as plain data', () => {
    const before = counts({ totalJobs: 500, totalPassingAllConfiguredFilters: 50 })
    const r = recordAcceptedProposal('sourceFunnel-3', 'sourceFunnel', 'Prioritize opportunities sourced from greenhouse.', before, ACCEPTED_AT)

    expect(r.proposalId).toBe('sourceFunnel-3')
    expect(r.question).toBe('sourceFunnel')
    expect(r.title).toBe('Prioritize opportunities sourced from greenhouse.')
    expect(r.acceptedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(r.metricsBefore).toEqual(before)
  })
})

describe('measureProposalEffect — refusal below the observation window', () => {
  it('refuses when barely any time has passed (1 hour, plenty of new jobs)', () => {
    const r = record()
    const now = hoursAfter(1)
    const result = measureProposalEffect(r, counts({ totalJobs: 200, totalPassingAllConfiguredFilters: 40 }), now)

    expect(result.status).toBe('insufficient_data')
    if (result.status !== 'insufficient_data') throw new Error('unreachable')
    expect(result.sampleSize).toBe(1)
    expect(result.minRequired).toBe(MIN_OBSERVATION_WINDOW_HOURS)
    expect(result.message).toContain('Widen your seniority range.')
    expect(result.message).toContain('have 1')
    expect(result.message).toContain(`need about ${MIN_OBSERVATION_WINDOW_HOURS}`)
  })

  it('refuses at exactly one hour under the threshold (boundary, exclusive)', () => {
    const r = record()
    const now = hoursAfter(MIN_OBSERVATION_WINDOW_HOURS - 1)
    const result = measureProposalEffect(r, counts({ totalJobs: 500, totalPassingAllConfiguredFilters: 100 }), now)

    expect(result.status).toBe('insufficient_data')
  })

  it('does not refuse on the window alone at exactly the threshold (boundary, inclusive)', () => {
    const r = record()
    const now = hoursAfter(MIN_OBSERVATION_WINDOW_HOURS)
    // Plenty of new jobs too, so a pass here proves the WINDOW gate specifically let it through.
    const result = measureProposalEffect(r, counts({ totalJobs: 500, totalPassingAllConfiguredFilters: 100 }), now)

    expect(result.status).toBe('answered')
  })
})

describe('measureProposalEffect — refusal below the new-jobs sample floor', () => {
  it('refuses on too few new jobs even once the window has passed', () => {
    const r = record()
    const now = hoursAfter(200) // window satisfied
    const result = measureProposalEffect(r, counts({ totalJobs: 103, totalPassingAllConfiguredFilters: 12 }), now) // only 3 new jobs

    expect(result.status).toBe('insufficient_data')
    if (result.status !== 'insufficient_data') throw new Error('unreachable')
    expect(result.sampleSize).toBe(3)
    expect(result.minRequired).toBe(MIN_NEW_JOBS_SAMPLE)
    expect(result.message).toContain('new jobs scraped since')
  })

  it('refuses at exactly one job under the sample floor (boundary, exclusive)', () => {
    const r = record()
    const now = hoursAfter(200)
    const newJobs = MIN_NEW_JOBS_SAMPLE - 1
    const result = measureProposalEffect(r, counts({ totalJobs: 100 + newJobs, totalPassingAllConfiguredFilters: 10 + newJobs }), now)

    expect(result.status).toBe('insufficient_data')
  })

  it('does not refuse at exactly the sample floor (boundary, inclusive)', () => {
    const r = record()
    const now = hoursAfter(200)
    const result = measureProposalEffect(r, counts({ totalJobs: 100 + MIN_NEW_JOBS_SAMPLE, totalPassingAllConfiguredFilters: 10 + MIN_NEW_JOBS_SAMPLE }), now)

    expect(result.status).toBe('answered')
  })

  it('never reports a negative or fabricated sample when totalJobs somehow shrinks', () => {
    // Defensive: totalJobs going down (a purge, a re-scrape correction) should
    // never surface as a negative "new jobs" count.
    const r = record()
    const now = hoursAfter(200)
    const result = measureProposalEffect(r, counts({ totalJobs: 50, totalPassingAllConfiguredFilters: 5 }), now)

    expect(result.status).toBe('insufficient_data')
    if (result.status !== 'insufficient_data') throw new Error('unreachable')
    expect(result.sampleSize).toBe(0)
  })
})

describe('measureProposalEffect — verdicts once both floors are cleared', () => {
  // Baseline throughout: before = 100 jobs / 10 passing = 10% pass rate.
  // After = 200 jobs (100 new, well past the 20 floor) at varying pass counts.
  const now = () => hoursAfter(200)

  it('reports improved when the pass rate rises well past the meaningful-delta floor', () => {
    const r = record()
    const result = measureProposalEffect(r, counts({ totalJobs: 200, totalPassingAllConfiguredFilters: 50 }), now()) // 25% vs 10%

    expect(result.status).toBe('answered')
    if (result.status !== 'answered') throw new Error('unreachable')
    expect(result.data.verdict).toBe('improved')
    expect(result.data.passRateBefore).toBeCloseTo(0.1)
    expect(result.data.passRateAfter).toBeCloseTo(0.25)
    expect(result.data.passRateDelta).toBeCloseTo(0.15)
    expect(result.summary).toContain('improvement')
  })

  it('reports regressed when the pass rate falls well past the meaningful-delta floor', () => {
    const r = record()
    const result = measureProposalEffect(r, counts({ totalJobs: 200, totalPassingAllConfiguredFilters: 5 }), now()) // 2.5% vs 10%

    expect(result.status).toBe('answered')
    if (result.status !== 'answered') throw new Error('unreachable')
    expect(result.data.verdict).toBe('regressed')
    expect(result.data.passRateDelta).toBeCloseTo(-0.075)
    expect(result.summary).toContain('regression')
  })

  it('reports no_change when the pass rate barely moves', () => {
    const r = record()
    const result = measureProposalEffect(r, counts({ totalJobs: 200, totalPassingAllConfiguredFilters: 22 }), now()) // 11% vs 10%

    expect(result.status).toBe('answered')
    if (result.status !== 'answered') throw new Error('unreachable')
    expect(result.data.verdict).toBe('no_change')
    expect(result.summary).toContain('no meaningful change')
  })

  it('boundary: exactly +MIN_MEANINGFUL_PASS_RATE_DELTA is no_change, not improved', () => {
    const r = record()
    // before rate 0.10 over 100 jobs; after rate exactly 0.12 over 200 jobs => delta exactly 0.02
    const result = measureProposalEffect(r, counts({ totalJobs: 200, totalPassingAllConfiguredFilters: 24 }), now())

    expect(result.status).toBe('answered')
    if (result.status !== 'answered') throw new Error('unreachable')
    expect(result.data.passRateDelta).toBeCloseTo(MIN_MEANINGFUL_PASS_RATE_DELTA)
    expect(result.data.verdict).toBe('no_change')
  })

  it('boundary: just over +MIN_MEANINGFUL_PASS_RATE_DELTA is improved', () => {
    const r = record()
    // after rate 0.125 over 200 jobs => delta 0.025, just past the 0.02 floor
    const result = measureProposalEffect(r, counts({ totalJobs: 200, totalPassingAllConfiguredFilters: 25 }), now())

    expect(result.status).toBe('answered')
    if (result.status !== 'answered') throw new Error('unreachable')
    expect(result.data.verdict).toBe('improved')
  })

  it('boundary: exactly -MIN_MEANINGFUL_PASS_RATE_DELTA is no_change, not regressed', () => {
    const r = record()
    // after rate exactly 0.08 over 200 jobs => delta exactly -0.02
    const result = measureProposalEffect(r, counts({ totalJobs: 200, totalPassingAllConfiguredFilters: 16 }), now())

    expect(result.status).toBe('answered')
    if (result.status !== 'answered') throw new Error('unreachable')
    expect(result.data.passRateDelta).toBeCloseTo(-MIN_MEANINGFUL_PASS_RATE_DELTA)
    expect(result.data.verdict).toBe('no_change')
  })

  it('boundary: just under -MIN_MEANINGFUL_PASS_RATE_DELTA is regressed', () => {
    const r = record()
    // after rate 0.075 over 200 jobs => delta -0.025, just past the -0.02 floor
    const result = measureProposalEffect(r, counts({ totalJobs: 200, totalPassingAllConfiguredFilters: 15 }), now())

    expect(result.status).toBe('answered')
    if (result.status !== 'answered') throw new Error('unreachable')
    expect(result.data.verdict).toBe('regressed')
  })

  it('never divides by zero when totalJobs is 0 on either side, and does not fabricate a verdict', () => {
    const r = recordAcceptedProposal('filterImpact-2', 'filterImpact', 'Drop an excluded keyword.', counts({ totalJobs: 0, totalPassingAllConfiguredFilters: 0 }), ACCEPTED_AT)
    const result = measureProposalEffect(r, counts({ totalJobs: 40, totalPassingAllConfiguredFilters: 4 }), now())

    expect(result.status).toBe('answered')
    if (result.status !== 'answered') throw new Error('unreachable')
    expect(result.data.passRateBefore).toBeNull()
    expect(result.data.passRateDelta).toBeNull()
    expect(result.data.verdict).toBe('no_change')
  })

  it('flags the result as still thin just past the sample floor', () => {
    const r = record()
    const result = measureProposalEffect(r, counts({ totalJobs: 100 + MIN_NEW_JOBS_SAMPLE, totalPassingAllConfiguredFilters: 10 + MIN_NEW_JOBS_SAMPLE }), now())

    expect(result.status).toBe('answered')
    if (result.status !== 'answered') throw new Error('unreachable')
    expect(result.caveats.some((c) => c.includes('Still thin'))).toBe(true)
  })

  it('always carries the volume-vs-outcome caveat, even on a clean improvement', () => {
    const r = record()
    const result = measureProposalEffect(r, counts({ totalJobs: 200, totalPassingAllConfiguredFilters: 50 }), now())

    expect(result.status).toBe('answered')
    if (result.status !== 'answered') throw new Error('unreachable')
    expect(result.caveats.some((c) => c.includes('Volume signal only'))).toBe(true)
  })
})
