import { describe, expect, it } from 'vitest'
import { checkMatchVerdictDeterministic, needsJudgeSample, shouldSampleForJudge } from './matcher'
import type { LlmVerdict } from '../../harness/agents/matcher'

function verdict(over: Partial<LlmVerdict> = {}): LlmVerdict {
  return {
    score: 85,
    skillsMatch: 80,
    experienceMatch: 90,
    locationMatch: 100,
    strengths: ['Strong Go background'],
    gaps: ['Kubernetes experience'],
    seniorityFit: 'Strong fit for senior IC',
    summary: 'Good overall fit.',
    matchedSkills: ['Go'],
    missingSkills: ['Kubernetes'],
    ...over,
  }
}

const JOB_TEXT = 'We need a backend engineer with Go experience. Kubernetes experience is required for this role.'

describe('checkMatchVerdictDeterministic', () => {
  it('passes a well-formed verdict whose evidence traces to the job text', () => {
    const result = checkMatchVerdictDeterministic(verdict(), JOB_TEXT)
    expect(result).toEqual({ ok: true, reasons: [] })
  })

  it('fails on an out-of-range score', () => {
    const result = checkMatchVerdictDeterministic(verdict({ score: 150 }), JOB_TEXT)
    expect(result.ok).toBe(false)
    expect(result.reasons.some((r) => r.includes('score'))).toBe(true)
  })

  it('fails on a missing summary or seniorityFit (schema-complete)', () => {
    expect(checkMatchVerdictDeterministic(verdict({ summary: '' }), JOB_TEXT).ok).toBe(false)
    expect(checkMatchVerdictDeterministic(verdict({ seniorityFit: '' }), JOB_TEXT).ok).toBe(false)
  })

  it('FABRICATED EVIDENCE: fails when a gap/missingSkill never appears in the job text', () => {
    const result = checkMatchVerdictDeterministic(verdict({ gaps: ['Requires a PhD in astrophysics'] }), JOB_TEXT)
    expect(result.ok).toBe(false)
    expect(result.reasons.some((r) => r.includes('unsupported evidence'))).toBe(true)
  })
})

describe('shouldSampleForJudge — deterministic index-hash, not Math.random', () => {
  it('is a pure function of jobId — replay-deterministic', () => {
    const a = shouldSampleForJudge('job-42')
    const b = shouldSampleForJudge('job-42')
    expect(a).toBe(b)
  })

  it('samples roughly the requested rate across many ids', () => {
    let sampled = 0
    const n = 5000
    for (let i = 0; i < n; i++) if (shouldSampleForJudge(`job-${i}`, 0.1)) sampled++
    const rate = sampled / n
    expect(rate).toBeGreaterThan(0.07)
    expect(rate).toBeLessThan(0.13)
  })
})

describe('needsJudgeSample', () => {
  it('always samples a score at/above the action threshold', () => {
    expect(needsJudgeSample(verdict({ score: 90 }), 'any-job-id-at-all', 85)).toBe(true)
  })

  it('below threshold, delegates entirely to shouldSampleForJudge — never always-true, never always-false', () => {
    const low = verdict({ score: 10 })
    // A wide, varied id pool (not a narrow sequential range, which this hash
    // — like most short-string hashes — can cluster on) so both outcomes are
    // certain to appear.
    let rejected: string | null = null
    let accepted: string | null = null
    for (let i = 0; i < 5000 && (!rejected || !accepted); i++) {
      const id = `job-${i}-${i * 7919}`
      if (shouldSampleForJudge(id)) accepted = accepted ?? id
      else rejected = rejected ?? id
    }
    expect(rejected).not.toBeNull()
    expect(accepted).not.toBeNull()
    expect(needsJudgeSample(low, rejected!, 85)).toBe(false)
    expect(needsJudgeSample(low, accepted!, 85)).toBe(true)
  })
})
