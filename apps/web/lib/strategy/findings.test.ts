// T33's fixture table: each finding's counts equal the hand counts, nothing is stated below its threshold, and the
// threshold's own sentence is shown instead.

import { describe, expect, it } from 'vitest'
import { findingsFrom } from './findings'
import type { StrategyReport } from './types'

const bucket = (label: string, applications: number, replies: number, thin = false) => ({ label, applications, replies, interviews: 0, replyRate: applications ? replies / applications : null, interviewRate: null, thinBucket: thin })
const answered = (question: string, buckets: ReturnType<typeof bucket>[]) => ({ status: 'answered' as const, question, sampleSize: buckets.reduce((s, b) => s + b.applications, 0), minRequired: 15, data: { totalApplications: 0, totalWithKnownSource: 0, buckets }, summary: '', caveats: [] })
const short = (question: string, message: string) => ({ status: 'insufficient_data' as const, question, sampleSize: 3, minRequired: 15, message })

const report = (over: Record<string, unknown>) =>
  ({
    sourceFunnel: short('sourceFunnel', 'Reply rates by source appear from 15 applications.'),
    chanceAccuracy: short('chanceAccuracy', 'x'),
    resumeVariants: short('resumeVariants', 'Reply rates by resume appear from 10 applications.'),
    outreachImpact: short('outreachImpact', 'Reply rates by outreach appear from 20 applications.'),
    rejectionPatterns: short('rejectionPatterns', 'x'),
    applicationTiming: short('applicationTiming', 'Reply rates by timing appear from 15 applications.'),
    proposals: [],
    ...over,
  }) as unknown as StrategyReport

describe('findings', () => {
  it('counts equal the hand counts and split by the overall rate', () => {
    const f = findingsFrom(report({ sourceFunnel: answered('sourceFunnel', [bucket('Referral', 9, 5), bucket('Job board', 12, 1), bucket('Site', 3, 0, true)]) }))
    expect(f.working.map((x) => [x.line, x.applications, x.replies])).toEqual([['5 of 9 applications from Referral got a reply.', 9, 5]])
    expect(f.notWorking.map((x) => [x.applications, x.replies])).toEqual([[12, 1]])
  })

  it('states nothing for a thin bucket, and gives the threshold sentence for a question below it', () => {
    const f = findingsFrom(report({ sourceFunnel: answered('sourceFunnel', [bucket('Referral', 9, 5), bucket('Job board', 12, 1), bucket('Site', 3, 0, true)]) }))
    expect([...f.working, ...f.notWorking].some((x) => x.line.includes('Site'))).toBe(false)
    expect(f.thresholds).toContain('Reply rates by resume appear from 10 applications.')
    expect(f.thresholds).not.toContain('Reply rates by source appear from 15 applications.')
  })

  it('with no answered question there are no findings at all, only thresholds', () => {
    const f = findingsFrom(report({}))
    expect(f.working).toEqual([])
    expect(f.notWorking).toEqual([])
    expect(f.thresholds).toHaveLength(6)
  })

  it('a finding carries the proposal that came with it', () => {
    const proposals = [{ id: 'p1', title: 'Prioritize opportunities sourced from Referral.', change: 'Show Referral roles first.', why: '', evidence: [{ question: 'sourceFunnel', sampleSize: 21, summary: '' }], expectedEffect: '', status: 'proposed' }]
    const f = findingsFrom(report({ sourceFunnel: answered('sourceFunnel', [bucket('Referral', 9, 5), bucket('Job board', 12, 1)]), proposals }))
    expect(f.working[0].proposal).toMatchObject({ id: 'p1', change: 'Show Referral roles first.' })
    expect(f.notWorking[0].proposal).toBeNull()
  })

  it('a working finding says what Keep changes and where it acts; a finding that is not working has nothing to keep', () => {
    const f = findingsFrom(report({ sourceFunnel: answered('sourceFunnel', [bucket('Referral', 9, 5), bucket('Job board', 12, 1)]) }))
    expect(f.working[0]).toMatchObject({ dimension: 'source', change: 'Show roles from Referral first', acts: 'Which roles come first in Roles.' })
    expect(f.notWorking[0]).toMatchObject({ change: null, acts: null })
  })

  it('reads chance by band and rejections by company, role type and level, each with its counts', () => {
    const chance = { status: 'answered' as const, question: 'chanceAccuracy', sampleSize: 30, minRequired: 20, summary: '', caveats: [], data: { totalApplications: 30, totalAssessed: 30, verdict: 'validates', buckets: [{ ...bucket('strong', 10, 6), chance: 'strong' }, { ...bucket('stretch', 10, 1), chance: 'stretch' }, { ...bucket('possible', 2, 0, true), chance: 'possible' }] } }
    const rejection = { status: 'answered' as const, question: 'rejectionPatterns', sampleSize: 30, minRequired: 5, summary: '', caveats: [], data: { totalApplications: 30, totalRejected: 9, groupsTooThinToReport: 0, groups: [{ kind: 'company', key: 'Stripe', totalApplications: 6, rejected: 5, rejectionRate: 0.83 }, { kind: 'job_function', key: 'Backend', totalApplications: 8, rejected: 4, rejectionRate: 0.5 }, { kind: 'seniority', key: 'Staff', totalApplications: 5, rejected: 3, rejectionRate: 0.6 }] } }
    const f = findingsFrom(report({ chanceAccuracy: chance, rejectionPatterns: rejection }))
    expect(f.working.map((x) => [x.dimension, x.line])).toEqual([['chance', '6 of 10 applications on Strong roles got a reply (60%).']])
    expect(f.notWorking.map((x) => [x.dimension, x.applications, x.line])).toEqual([
      ['chance', 10, '1 of 10 applications on Stretch roles got a reply (10%).'],
      ['company', 6, '5 of 6 applications in Stripe were rejected.'],
      ['role type', 8, '4 of 8 applications in Backend were rejected.'],
      ['level', 5, '3 of 5 applications in Staff were rejected.'],
    ])
    expect(f.thresholds).not.toContain('x')
  })

  it('adds reply time, stalls, why applications closed and follow-ups, and their thresholds', () => {
    const shape = { working: [{ key: 'shape:reply-time', dimension: 'reply time' as const, line: 'Replies came a median of 4 days after you applied: 6 replies from 14 sent.', applications: 14, replies: 6 }], notWorking: [], thresholds: ['Why applications close appears from 5 closed applications.'] }
    const f = findingsFrom(report({}), shape)
    expect(f.working.map((x) => x.key)).toEqual(['shape:reply-time'])
    expect(f.working[0]).toMatchObject({ change: null, proposal: null })
    expect(f.thresholds).toContain('Why applications close appears from 5 closed applications.')
  })

  it('a proposal no counted group carries is listed as noticed, with its own Keep', () => {
    const proposals = [{ id: 'p9', title: 'Consider skipping Stretch roles.', change: 'Keep Stretch roles out of the daily shortlist unless you ask for them.', why: '', evidence: [{ question: 'chanceAccuracy', sampleSize: 24, summary: '' }], expectedEffect: '', status: 'proposed' }]
    const f = findingsFrom(report({ proposals }))
    expect(f.noticed).toHaveLength(1)
    expect(f.noticed[0]).toMatchObject({ key: 'proposal:chanceAccuracy:consider-skipping-stretch-roles', line: 'Consider skipping Stretch roles.', change: 'Keep Stretch roles out of the daily shortlist unless you ask for them.', acts: 'The suggestions for your search.', keep: { effect: 'search.propose' } })
  })
})
