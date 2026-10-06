import { describe, expect, it, vi } from 'vitest'
import { MAX_LISTING_PAGES, readCareersPage, pageReaderUserPrompt } from './page-reader'
import { MODEL_LIMIT, type ModelCall } from './model'
import { snapshotPage } from './snapshot'
import type { FetchPage } from './fetch-page'

const URL1 = 'https://acme.com/careers'
const FILLER = 'We are a team that cares about customers and about each other, and we work in the open. '.repeat(3)

const LISTING = `<html><body><h1>Open roles</h1><p>${FILLER}</p>
  <div><h3>Senior Backend Engineer</h3><p>Remote</p><a href="/jobs/1">Apply</a></div>
  <div><h3>Product Designer</h3><p>London</p><a href="/jobs/2">Apply</a></div>
  <a href="/careers?page=2">Next</a></body></html>`

const LISTING_P2 = `<html><body><h1>Open roles</h1><p>${FILLER}</p>
  <div><h3>Data Analyst</h3><a href="/jobs/3">Apply</a></div></body></html>`

const SHELL = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'

function pages(map: Record<string, string>): FetchPage {
  return vi.fn(async (url: string) => {
    const html = map[url]
    if (html === undefined) throw new Error('http_404')
    return { html, finalUrl: url, rendered: false }
  })
}

const answerFor = (jobs: { title: string; link: number | null }[], kind = 'listing') => JSON.stringify({ page_kind: kind, jobs })

describe('readCareersPage', () => {
  it('reads structured postings without asking a model', async () => {
    const ld = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'JobPosting', title: 'Backend Engineer', url: 'https://acme.com/jobs/1', description: '<p>Build.</p>' },
        { '@type': 'JobPosting', title: 'Designer', url: 'https://acme.com/jobs/2' },
      ],
    }
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>${FILLER}</body></html>`
    const model = vi.fn<Parameters<ModelCall>, ReturnType<ModelCall>>()
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: pages({ [URL1]: html }), model })
    expect(model).not.toHaveBeenCalled()
    expect(res.jobs.map((j) => j.title)).toEqual(['Backend Engineer', 'Designer'])
    expect(res.complete).toBe(true)
    expect(res.modelCalls).toBe(0)
  })

  it('reports model_unavailable and guesses nothing when there is no model', async () => {
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: pages({ [URL1]: LISTING }), model: null })
    expect(res).toMatchObject({ jobs: [], complete: false, reason: 'model_unavailable' })
  })

  it('reports model_limit when the allowance is spent', async () => {
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: pages({ [URL1]: LISTING }), model: async () => MODEL_LIMIT })
    expect(res.reason).toBe('model_limit')
    expect(res.modelCalls).toBe(0)
  })

  it('reports fetch_failed when the page does not load', async () => {
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: pages({}), model: async () => '{}' })
    expect(res).toMatchObject({ jobs: [], reason: 'fetch_failed' })
  })

  it('does not spend a model call on a page with no text of its own', async () => {
    const model = vi.fn(async () => answerFor([]))
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: pages({ [URL1]: SHELL }), model })
    expect(model).not.toHaveBeenCalled()
    expect(res.reason).toBe('page_unconfirmed')
  })

  it('keeps the jobs the page backs up and counts the ones it does not', async () => {
    const snap = snapshotPage(LISTING, URL1)
    const apply = (n: string) => snap.links.findIndex((l) => l.href.endsWith(n)) + 1
    const model = vi.fn(async () =>
      answerFor([
        { title: 'Senior Backend Engineer', link: apply('/jobs/1') },
        { title: 'Product Designer', link: apply('/jobs/2') },
        { title: 'Chief Wizard', link: apply('/jobs/2') },
      ])
    )
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: pages({ [URL1]: LISTING.replace(/<a href="\/careers\?page=2">Next<\/a>/, '') }), model })
    expect(res.jobs.map((j) => j.title)).toEqual(['Senior Backend Engineer', 'Product Designer'])
    expect(res.dropped).toBe(1)
    expect(res.complete).toBe(true)
    expect(res.modelCalls).toBe(1)
  })

  it('reports page_unconfirmed when nothing the model named is on the page', async () => {
    const model = async () => answerFor([{ title: 'Chief Wizard', link: 1 }])
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: pages({ [URL1]: LISTING }), model })
    expect(res).toMatchObject({ jobs: [], reason: 'page_unconfirmed', dropped: 1 })
  })

  it('is not a failure when the page honestly lists no role', async () => {
    const model = async () => answerFor([], 'no_postings')
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: pages({ [URL1]: LISTING }), model })
    expect(res).toMatchObject({ jobs: [], reason: null, complete: false })
  })

  it('says the list is not complete when the snapshot was truncated', async () => {
    const big = `<html><body>${'<p>filler text for the page</p>'.repeat(3000)}<div><h3>Data Analyst</h3><a href="/jobs/3">Apply</a></div></body></html>`
    const snap = snapshotPage(big, URL1)
    expect(snap.truncated).toBe(true)
    const model = async () => answerFor([{ title: 'Data Analyst', link: snap.links.findIndex((l) => l.href.endsWith('/jobs/3')) + 1 }])
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: pages({ [URL1]: big }), model })
    expect(res.jobs).toHaveLength(1)
    expect(res.complete).toBe(false)
  })

  it('follows the next page only after a page that lists postings, on the same site', async () => {
    const s1 = snapshotPage(LISTING, URL1)
    const s2 = snapshotPage(LISTING_P2, 'https://acme.com/careers?page=2')
    const model = vi
      .fn<Parameters<ModelCall>, ReturnType<ModelCall>>()
      .mockResolvedValueOnce(
        answerFor([
          { title: 'Senior Backend Engineer', link: s1.links.findIndex((l) => l.href.endsWith('/jobs/1')) + 1 },
          { title: 'Product Designer', link: s1.links.findIndex((l) => l.href.endsWith('/jobs/2')) + 1 },
        ])
      )
      .mockResolvedValueOnce(answerFor([{ title: 'Data Analyst', link: s2.links.findIndex((l) => l.href.endsWith('/jobs/3')) + 1 }]))
    const fetchPage = pages({ [URL1]: LISTING, 'https://acme.com/careers?page=2': LISTING_P2 })
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage, model })
    expect(res.jobs.map((j) => j.title)).toEqual(['Senior Backend Engineer', 'Product Designer', 'Data Analyst'])
    expect(res.modelCalls).toBe(2)
    expect(res.complete).toBe(true)

    // A next link on a page that lists nothing is navigation, not pagination.
    const none = vi.fn(async () => answerFor([], 'no_postings'))
    const fetchNone = pages({ [URL1]: LISTING })
    await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: fetchNone, model: none })
    expect(fetchNone).toHaveBeenCalledTimes(1)

    // And another host is never followed.
    const offsite = LISTING.replace('/careers?page=2', 'https://elsewhere.example/careers?page=2')
    const fetchOff = pages({ [URL1]: offsite })
    await readCareersPage(
      { name: 'Acme', career_url: URL1 },
      { fetchPage: fetchOff, model: async () => answerFor([{ title: 'Senior Backend Engineer', link: s1.links.findIndex((l) => l.href.endsWith('/jobs/1')) + 1 }]) }
    )
    expect(fetchOff).toHaveBeenCalledTimes(1)
  })

  it('stops at the page cap and says the list is not complete', async () => {
    const mk = (n: number) =>
      `<html><body><p>${FILLER}</p><div><h3>Role ${n}</h3><a href="/jobs/${n}">Apply</a></div><a href="/careers?page=${n + 1}">Next</a></body></html>`
    const map: Record<string, string> = { [URL1]: mk(1) }
    for (let n = 2; n <= 6; n++) map[`https://acme.com/careers?page=${n}`] = mk(n)
    let call = 0
    const model: ModelCall = async () => {
      call++
      const snap = snapshotPage(mk(call), URL1)
      return answerFor([{ title: `Role ${call}`, link: snap.links.findIndex((l) => l.href.endsWith(`/jobs/${call}`)) + 1 }])
    }
    const res = await readCareersPage({ name: 'Acme', career_url: URL1 }, { fetchPage: pages(map), model })
    expect(res.jobs).toHaveLength(MAX_LISTING_PAGES)
    expect(res.complete).toBe(false)
  })

  it('fills a confirmed posting from its own page', async () => {
    const snap = snapshotPage(LISTING, URL1)
    const model = async () => answerFor([{ title: 'Senior Backend Engineer', link: snap.links.findIndex((l) => l.href.endsWith('/jobs/1')) + 1 }])
    const detail = `<html><body><main><h1>Senior Backend Engineer</h1><p>${'You will build and run the services behind our product. '.repeat(8)}</p></main></body></html>`
    const res = await readCareersPage(
      { name: 'Acme', career_url: URL1 },
      { fetchPage: pages({ [URL1]: LISTING.replace(/<a href="\/careers\?page=2">Next<\/a>/, '') }), model, fetchDetail: async () => detail }
    )
    expect(res.jobs[0].description).toContain('services behind our product')
    expect(res.detail).toEqual({ fetched: 1, filled: 1 })
  })
})

describe('pageReaderUserPrompt', () => {
  it('fences the page and lists numbered links', () => {
    const prompt = pageReaderUserPrompt('Acme', snapshotPage(LISTING, URL1))
    expect(prompt).toContain('BEGIN UNTRUSTED CAREERS PAGE')
    expect(prompt).toContain('[1] Apply -> https://acme.com/jobs/1')
  })
})
