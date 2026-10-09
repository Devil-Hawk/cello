import { describe, expect, it } from 'vitest'
import { checkNote, routeIntent } from './route'

describe('routeIntent', () => {
  it('reads a find with a type, a place and a count', () => {
    expect(routeIntent('Find me data engineer roles in San Francisco')).toEqual({ kind: 'find', type: 'data engineer', place: 'San Francisco', company: null, limit: 5 })
    expect(routeIntent('Find me 3 FDE roles in SF')).toMatchObject({ type: 'FDE', place: 'SF', limit: 3 })
    expect(routeIntent('show me remote roles at Stripe')).toMatchObject({ type: null, place: 'remote', company: 'Stripe' })
  })
  it('reads a compare of the top few', () => {
    expect(routeIntent('Compare my top three')).toEqual({ kind: 'compare', n: 3 })
    expect(routeIntent('compare my top 4 roles')).toEqual({ kind: 'compare', n: 4 })
  })
  it('reads a draft only for a company the person holds', () => {
    const typed = 'Draft a short note to the Retell AI recruiter asking about the timeline'
    expect(routeIntent(typed, ['Linear', 'Retell AI'])).toEqual({ kind: 'draft', company: 'Retell AI', ask: 'the timeline' })
    expect(routeIntent(typed, ['Linear'])).toBeNull()
  })
  it('leaves everything else to the loop', () => {
    expect(routeIntent('What should I focus on this week?')).toBeNull()
  })
})

describe('checkNote', () => {
  const input = { company: 'Retell AI', title: 'Deployment Strategist', ask: 'the timeline', evidence: ['Eight years building data services.'] }
  const good = 'Subject: Deployment Strategist at Retell AI\n\nHello,\n\nI am writing about the Deployment Strategist role at Retell AI. I have eight years building data services. The work looks close to what I do best. Could you share the timeline for next steps?\n\nThank you,\nRiley Marsh'
  it('accepts a short note that names the company and role and asks the one thing', () => {
    expect(checkNote(good, input)?.subject).toBe('Deployment Strategist at Retell AI')
  })
  it('refuses placeholders, a missing ask, a wrong length and invented numbers', () => {
    expect(checkNote(good.replace('Hello,', 'Hi [Name],'), input)).toBeNull()
    expect(checkNote(good.replace('timeline', 'plans'), input)).toBeNull()
    expect(checkNote(good.replace(' The work looks close to what I do best.', ''), input)).toBeNull()
    expect(checkNote(good.replace('eight years', '12 years'), input)).toBeNull()
  })
})
