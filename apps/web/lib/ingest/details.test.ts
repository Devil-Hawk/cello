import { describe, expect, it, vi } from 'vitest'
import { descriptionFromPage, fillDescriptions } from './details'
import type { AtsJob } from '../ats/types'

const BODY = 'You will design and run the data platform for our analytics team. '.repeat(8)

const page = (inner: string, head = '') => `<html><head>${head}</head><body><nav><a href="/">Home</a></nav>${inner}<footer>Copyright</footer></body></html>`

describe('descriptionFromPage', () => {
  it('prefers the description the employer declared over the page text', () => {
    const ld = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Data Engineer',
      description: `<p>${'Declared text. '.repeat(30)}</p>`,
    })}</script>`
    const html = page(`<main><h1>Data Engineer</h1><p>${BODY}</p></main>`, ld)
    expect(descriptionFromPage(html, 'https://acme.com/j/1', 'Data Engineer')).toContain('Declared text.')
  })

  it('falls back to the main region, without navigation or footer', () => {
    const text = descriptionFromPage(page(`<main><h1>Data Engineer</h1><p>${BODY}</p></main>`), 'https://acme.com/j/1', 'Data Engineer')!
    expect(text).toContain('data platform')
    expect(text).not.toContain('Copyright')
    expect(text).not.toContain('Home')
  })

  it('gives no description when the page does not name the job', () => {
    expect(descriptionFromPage(page(`<main><h1>Careers</h1><p>${BODY}</p></main>`), 'https://acme.com/j/1', 'Data Engineer')).toBeUndefined()
  })

  it('gives no description for a page too short to be one', () => {
    expect(descriptionFromPage(page('<main><h1>Data Engineer</h1><p>Apply now.</p></main>'), 'https://acme.com/j/1', 'Data Engineer')).toBeUndefined()
  })
})

const job = (n: number, extra: Partial<AtsJob> = {}): AtsJob => ({
  title: `Role ${n}`,
  url: `https://acme.com/j/${n}`,
  externalId: `https://acme.com/j/${n}`,
  ...extra,
})

describe('fillDescriptions', () => {
  const fetchHtml = vi.fn(async (url: string) => {
    const n = url.split('/').pop()
    return page(`<main><h1>Role ${n}</h1><p>${BODY}</p></main>`)
  })

  it('respects the cap and fetches only postings that still need a body', async () => {
    fetchHtml.mockClear()
    const jobs = [job(1), job(2, { description: 'already here' }), job(3), job(4), job(5)]
    const needs = (id: string) => !id.endsWith('/3')
    const out = await fillDescriptions(jobs, { needs, fetchHtml, max: 2 })
    expect(fetchHtml).toHaveBeenCalledTimes(2)
    expect(out.fetched).toBe(2)
    expect(out.jobs[0].description).toContain('data platform')
    expect(out.jobs[1].description).toBe('already here')
    expect(out.jobs[2].description).toBeUndefined()
    expect(out.jobs[4].description).toBeUndefined()
  })

  it('leaves a posting as listed when its page fails or names another job', async () => {
    const mixed = async (url: string) => {
      if (url.endsWith('/1')) throw new Error('http_500')
      return page(`<main><h1>Something else</h1><p>${BODY}</p></main>`)
    }
    const out = await fillDescriptions([job(1), job(2)], { needs: () => true, fetchHtml: mixed })
    expect(out.filled).toBe(0)
    expect(out.jobs.every((j) => j.description === undefined)).toBe(true)
  })
})
