import { describe, expect, it } from 'vitest'
import { letterNote } from './letter-note'

const pair = (n: number) => Array.from({ length: n }, (_, i) => ({ job: `J${i}`, resume: `R${i}` }))

describe('letterNote', () => {
  it('says why a full letter is full', () => {
    expect(letterNote({ tier: 'full', evidence: pair(4), companyFact: null }).tier).toBe("Full letter. Your resume backs 4 of this role's requirements.")
  })

  it('says a focused letter stays on what the resume backs', () => {
    expect(letterNote({ tier: 'focused', evidence: pair(1), companyFact: null }).tier).toBe(
      "Short letter. Your resume backs 1 of this role's requirements, so the letter stays on that."
    )
    expect(letterNote({ tier: 'focused', evidence: pair(2), companyFact: null }).tier).toContain('stays on those.')
  })

  it('tells a brief letter for a post with no description from one with no resume match', () => {
    expect(letterNote({ tier: 'brief', evidence: [], companyFact: null, hasJobPost: false }).tier).toBe(
      'Brief letter. The posting has no description, so the letter speaks to the title only.'
    )
    expect(letterNote({ tier: 'brief', evidence: [], companyFact: null, hasJobPost: true }).tier).toContain('stays short')
  })

  it('links the company fact the letter mentions, or says there is no research', () => {
    expect(letterNote({ tier: 'full', evidence: pair(3), companyFact: { text: 'Ships weekly', url: 'https://x.test' } }).company).toEqual({ text: 'Mentions: Ships weekly', url: 'https://x.test' })
    expect(letterNote({ tier: 'full', evidence: pair(3), companyFact: null, hasCompanyFacts: false }).company.text).toBe(
      'No company research on file, so the letter says nothing about the company. Research it from the company page.'
    )
  })
})
