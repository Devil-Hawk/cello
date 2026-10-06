import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { offerSuggestion } from './negotiation'

describe('the Offer suggestion', () => {
  it('is offered for an application at the offer stage, with the role named', () => {
    expect(offerSuggestion({ id: 'a1', stage: 'offer', jobTitle: 'Product Manager', companyName: 'Northstar' })).toEqual({
      label: 'Prepare to negotiate',
      skill: 'negotiation',
      applicationId: 'a1',
      message: 'Help me prepare to negotiate my offer for Product Manager at Northstar.',
    })
  })

  it('says it without a role when none is known', () => {
    expect(offerSuggestion({ id: 'a1', stage: 'offer' })?.message).toBe('Help me prepare to negotiate my offer.')
  })

  it.each(['discovered', 'applied', 'screen', 'interview', 'accepted', 'rejected'])('is not offered at %s', (stage) => {
    expect(offerSuggestion({ id: 'a1', stage })).toBeNull()
  })

  it('points at a skill that exists with an eval set', () => {
    const dir = path.join(process.cwd(), 'skills', 'negotiation')
    expect(readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('name: negotiation')
    expect(JSON.parse(readFileSync(path.join(dir, 'evals.json'), 'utf8')).skill).toBe('negotiation')
  })
})
