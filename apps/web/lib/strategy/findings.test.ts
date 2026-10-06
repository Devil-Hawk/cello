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
    expect(f.thresholds).toHaveLength(4)
  })

  it('a finding carries the proposal that came with it', () => {
    const proposals = [{ id: 'p1', title: 'Prioritize opportunities sourced from Referral.', change: 'Show Referral roles first.', why: '', evidence: [{ question: 'sourceFunnel', sampleSize: 21, summary: '' }], expectedEffect: '', status: 'proposed' }]
    const f = findingsFrom(report({ sourceFunnel: answered('sourceFunnel', [bucket('Referral', 9, 5), bucket('Job board', 12, 1)]), proposals }))
    expect(f.working[0].proposal).toMatchObject({ id: 'p1', change: 'Show Referral roles first.' })
    expect(f.notWorking[0].proposal).toBeNull()
  })
})
