// The code check on a drafted answer: a fact the person never gave is refused, a company quote not in the research
// is refused, and a draft inside the person's own words passes.

import { describe, expect, it } from 'vitest'
import { checkDraft } from './draft'

const own = 'Riley Marsh\nBackend engineer at Northwind, 2019 to 2024.\nLed a team of 6 engineers.\nWhy this company?\nI ran Kubernetes clusters for a payments team at Northwind for three years.'
const company = 'Acme was founded in 2010 and sells Observability tools. "Monitoring for everyone" is its line.'
const question = 'Why do you want to work at Acme?'

describe('checkDraft', () => {
  it('passes a draft inside the person\'s own words that names the company as written', () => {
    expect(checkDraft('I ran Kubernetes clusters for a payments team at Northwind for three years, and Acme sells Observability tools I would like to build. Leading a team of 6 engineers taught me to keep systems simple.', own, company, question)).toBeNull()
  })

  it('refuses a fact the person never gave', () => {
    expect(checkDraft('I led a team of 40 engineers at Google for twelve years.', own, company, question)).toMatch(/40|Google|twelve/)
    expect(checkDraft('I started at Northwind on 2016-03-01.', own, company, question)).toMatch(/the date mar 1/)
  })

  it('refuses quoted company words the research does not hold', () => {
    expect(checkDraft('Your line "observability for the brave" speaks to me.', own, company, question)).toMatch(/the quotation "observability for the brave"/)
    expect(checkDraft('Your line "Monitoring for everyone" speaks to me.', own, company, question)).toBeNull()
  })
})
