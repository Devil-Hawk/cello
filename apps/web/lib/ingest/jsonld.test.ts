import { describe, expect, it } from 'vitest'
import { readJobPostings } from './jsonld'

const PAGE = 'https://acme.com/careers'
const tag = (json: unknown) => `<script type="application/ld+json">${typeof json === 'string' ? json : JSON.stringify(json)}</script>`
const page = (...tags: string[]) => `<html><head>${tags.join('')}</head><body></body></html>`

describe('readJobPostings', () => {
  it('reads a posting inside @graph and a type given as an array', () => {
    const jobs = readJobPostings(
      page(
        tag({
          '@context': 'https://schema.org',
          '@graph': [
            { '@type': 'Organization', name: 'Acme' },
            { '@type': ['JobPosting'], title: 'Backend Engineer', url: '/jobs/1?utm_source=x', description: '<p>Build things</p>' },
          ],
        })
      ),
      PAGE
    )
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      title: 'Backend Engineer',
      url: 'https://acme.com/jobs/1?utm_source=x',
      externalId: 'https://acme.com/jobs/1',
      description: 'Build things',
    })
  })

  it('keeps two postings without a url apart instead of collapsing them onto the page', () => {
    const jobs = readJobPostings(
      page(tag([{ '@type': 'JobPosting', title: 'Designer' }, { '@type': 'JobPosting', title: 'Analyst' }])),
      PAGE
    )
    expect(jobs.map((j) => j.title)).toEqual(['Designer', 'Analyst'])
    expect(new Set(jobs.map((j) => j.externalId)).size).toBe(2)
    expect(jobs.every((j) => j.url.startsWith(PAGE))).toBe(true)
  })

  it('gives a lone posting without a url the page url', () => {
    const [job] = readJobPostings(page(tag({ '@type': 'JobPosting', title: 'Designer' })), PAGE)
    expect(job.url).toBe(PAGE)
    expect(job.externalId).toBe(PAGE)
  })

  it('keeps a description over 5,000 characters with its line breaks', () => {
    const body = Array.from({ length: 400 }, (_, i) => `<li>Requirement number ${i} of the role</li>`).join('')
    const [job] = readJobPostings(
      page(tag({ '@type': 'JobPosting', title: 'Engineer', url: 'https://acme.com/j/1', description: `<h2>Requirements</h2><ul>${body}</ul>` })),
      PAGE
    )
    expect(job.description!.length).toBeGreaterThan(5000)
    expect(job.description!.split('\n').length).toBeGreaterThan(300)
  })

  it('reads escaped markup in a description', () => {
    const [job] = readJobPostings(
      page(
        tag({
          '@type': 'JobPosting',
          title: 'Engineer',
          url: 'https://acme.com/j/1',
          description: '&lt;p&gt;Hello&lt;/p&gt;&lt;ul&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;',
        })
      ),
      PAGE
    )
    expect(job.description).not.toContain('<')
    expect(job.description).toContain('SQL')
  })

  it('reads telecommute, location parts, salary and date', () => {
    const [job] = readJobPostings(
      page(
        tag({
          '@type': 'JobPosting',
          title: 'Engineer',
          url: 'https://acme.com/j/1',
          jobLocationType: 'TELECOMMUTE',
          jobLocation: { '@type': 'Place', address: { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } },
          baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { minValue: 120000, maxValue: 160000, unitText: 'YEAR' } },
          datePosted: '2026-09-30',
        })
      ),
      PAGE
    )
    expect(job.location).toBe('Austin, TX, US · Remote')
    expect(job.salary).toBe('USD 120,000-160,000 / yr')
    expect(job.postedAt).toBe('2026-09-30T00:00:00.000Z')
  })

  it('does not lose the other blocks when one script is not valid JSON', () => {
    const jobs = readJobPostings(
      page(tag('{ not json'), tag({ '@type': 'JobPosting', title: 'Engineer', url: 'https://acme.com/j/1' })),
      PAGE
    )
    expect(jobs).toHaveLength(1)
  })

  it('returns nothing for a page with no postings in its markup', () => {
    expect(readJobPostings(page(tag({ '@type': 'Organization', name: 'Acme' })), PAGE)).toEqual([])
    expect(readJobPostings('<html></html>', PAGE)).toEqual([])
  })

  it('reads posting data with raw line breaks and tabs inside a string (Kaiser Permanente)', () => {
    const raw = '{"@type":"JobPosting","title":"Medical Assistant","description":"<p>Line one</p>\n\t<p>Line two</p>","datePosted":"2026-10-6"}'
    expect(() => JSON.parse(raw)).toThrow()
    const jobs = readJobPostings(page(tag(raw)), PAGE)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].title).toBe('Medical Assistant')
    expect(jobs[0].description).toContain('Line two')
  })
})
