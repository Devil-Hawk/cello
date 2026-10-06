import { describe, expect, it } from 'vitest'
import { businessDaysBetween, nextStep, type NextStepInput } from './next-step'

const NOW = new Date('2026-10-14T12:00:00Z') // a Wednesday

const base = (over: Partial<NextStepInput> = {}): NextStepInput => ({
  stage: 'applied', state: 'sent', closedReason: null, appliedAt: '2026-10-01T12:00:00Z', interviewAt: null, lastInbound: null,
  answeredAfterInbound: false, followUpDays: 7, now: NOW, ...over,
})

describe('nextStep', () => {
  it('counts business days, not calendar days', () => {
    // Friday the 9th to Wednesday the 14th: Monday, Tuesday, Wednesday
    expect(businessDaysBetween(new Date('2026-10-09T12:00:00Z'), NOW)).toBe(3)
  })

  it('asks for a reply to a verified mail nobody answered, and not to one that could not be verified', () => {
    const at = '2026-10-13T09:00:00Z'
    expect(nextStep(base({ lastInbound: { at, kind: 'interview', trust: 'proven' } }))?.kind).toBe('reply')
    expect(nextStep(base({ lastInbound: { at, kind: 'interview', trust: 'unconfirmed' }, appliedAt: '2026-10-12T12:00:00Z' }))).toBeNull()
    expect(nextStep(base({ lastInbound: { at, kind: 'interview', trust: 'proven' }, answeredAfterInbound: true }))).toBeNull()
  })

  it('names an offer that waits', () => {
    expect(nextStep(base({ lastInbound: { at: '2026-10-13T09:00:00Z', kind: 'offer', trust: 'proven' } }))?.kind).toBe('offer_due')
  })

  it('follows up after the person\'s own days of silence, and says nothing before', () => {
    expect(nextStep(base())?.kind).toBe('follow_up_due')
    expect(nextStep(base({ appliedAt: '2026-10-12T12:00:00Z' }))).toBeNull()
    expect(nextStep(base({ followUpDays: null }))).toBeNull()
  })

  it('lets a long silence go quiet', () => {
    expect(nextStep(base({ appliedAt: '2026-08-01T12:00:00Z' }))?.kind).toBe('gone_quiet')
  })

  it('says nothing about a closed application', () => {
    expect(nextStep(base({ stage: 'rejected' }))).toBeNull()
    expect(nextStep(base({ closedReason: 'skipped' }))).toBeNull()
  })
})
