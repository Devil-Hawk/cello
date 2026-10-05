import { describe, expect, it } from 'vitest'
import { employerNameFromPage, isGenericName, nameFromDomain } from './page-name'

const page = (head: string) => `<html><head>${head}</head><body></body></html>`

describe('employerNameFromPage', () => {
  it('Zalando: a marketing title is not the company, the domain is', () => {
    const html = page('<title>Find your career</title><meta property="og:title" content="Find your career"/>')
    expect(employerNameFromPage(html, 'https://jobs.zalando.com/en/jobs/', 'jobs.zalando.com')).toBe('Zalando')
  })

  it('takes the employer a posting declares first', () => {
    const ld = JSON.stringify({ '@type': 'JobPosting', title: 'Data Engineer', hiringOrganization: { name: 'Acme Robotics' }, url: 'https://x.test/jobs/1' })
    expect(employerNameFromPage(page(`<title>Data Engineer</title><script type="application/ld+json">${ld}</script>`), 'https://x.test/jobs/1', 'x.test')).toBe('Acme Robotics')
  })

  it('takes og:site_name without its careers word, and rejects a slogan there', () => {
    expect(employerNameFromPage(page('<meta property="og:site_name" content="Globex Careers"/>'), 'https://globex.test/jobs', 'globex.test')).toBe('Globex')
    expect(employerNameFromPage(page('<meta property="og:site_name" content="Join our team"/>'), 'https://globex.test/jobs', 'globex.test')).toBe('Globex')
  })

  it('reads a title only when it names the employer: "Careers at X" or "X Careers"', () => {
    expect(employerNameFromPage(page('<title>Careers at Initech</title>'), 'https://initech.test/c', 'initech.test')).toBe('Initech')
    expect(employerNameFromPage(page('<title>Hooli | Careers</title>'), 'https://hooli.test/c', 'hooli.test')).toBe('Hooli')
    expect(employerNameFromPage(page('<title>Join the best team in the world and build the future</title>'), 'https://umbrella.test/c', 'umbrella.test')).toBe('Umbrella')
  })

  it('a known company is named from the directory', () => {
    expect(employerNameFromPage(page('<title>Find your career</title>'), 'https://www.amazon.jobs/en', 'amazon.jobs')).toBe('Amazon')
  })
})

describe('isGenericName / nameFromDomain', () => {
  it('slogans and page labels are generic, names are not', () => {
    for (const s of ['Find your career', 'Careers', 'Open positions', 'Join us', 'Work with us today', '']) expect(isGenericName(s), s).toBe(true)
    for (const s of ['Zalando', 'Bending Spoons', 'Dataiku']) expect(isGenericName(s), s).toBe(false)
  })
  it('names a company by its domain', () => {
    expect(nameFromDomain('jobs.zalando.com')).toBe('Zalando')
    expect(nameFromDomain('careers.walmart.com')).toBe('Walmart')
  })
})
