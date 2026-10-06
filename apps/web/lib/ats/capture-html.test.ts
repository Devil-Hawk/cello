// Every applicant system hands back the employer's own HTML for a posting, and syncJobs keeps it whole as
// Markdown: each heading, paragraph and bullet of the body is still there, pay and place verbatim, and nothing of
// the markup that could act (scripts, frames, javascript: links) is. One payload for each provider the reader
// supports through an API; the site tiers are in lib/ingest/capture.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { postingCapture, postingMarkdown } from '../ingest/markdown'
import { ashby } from './ashby'
import { greenhouse } from './greenhouse'
import { lever } from './lever'
import { personio } from './personio'
import { recruitee } from './recruitee'
import { smartrecruiters } from './smartrecruiters'
import { workable } from './workable'
import type { AtsJob } from './types'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const xml = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } })
const route = (handler: (url: string) => Response) => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => handler(String(input))) as unknown as typeof fetch
}

/** What a posting says, as the employer wrote it: every block below must come out the other side. */
const BODY =
  '<h2>About the role</h2>' +
  '<p>You will build the payments API with <a href="https://example.com/docs?utm_source=x">our docs</a> open all day.</p>' +
  '<h3>What you will do</h3>' +
  '<ul><li>Own the ledger service end to end</li><li>Partner with Product &amp; Engineering</li></ul>' +
  '<h3>Requirements</h3>' +
  '<ul><li>5+ years of Go or Rust</li><li>Bachelor\'s degree or equivalent experience</li></ul>' +
  '<p>Salary: $140,000 - $180,000 plus equity. Location: Zürich (Hybrid, 3 days).</p>'
const BLOCKS = [
  'About the role',
  'You will build the payments API with our docs open all day.',
  'What you will do',
  'Own the ledger service end to end',
  'Partner with Product & Engineering',
  'Requirements',
  '5+ years of Go or Rust',
  "Bachelor's degree or equivalent experience",
  'Salary: $140,000 - $180,000 plus equity. Location: Zürich (Hybrid, 3 days).',
]

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
/** The Markdown as words: markers, escapes and link targets gone. */
const words = (md: string) => norm(md.replace(/\\(.)/g, '$1').replace(/\]\([^)]*\)/g, ']'))

function expectWhole(job: AtsJob | undefined, extra: string[] = []) {
  expect(job?.descriptionHtml, 'the employer\'s HTML is kept').toBeTruthy()
  const { md, state } = postingMarkdown(job!.descriptionHtml!)
  expect(state).toBe('full')
  const hay = words(md)
  for (const block of [...BLOCKS, ...extra]) expect(hay, block).toContain(norm(block))
  expect(md).not.toContain('utm_source')
  // stored beside the plain copy, with the hash of the Markdown
  const cap = postingCapture(job!)
  expect(cap).toMatchObject({ description_md: md, description_state: 'full' })
  expect(cap.description_md5).toMatch(/^[0-9a-f]{32}$/)
}

describe('every provider keeps the employer\'s HTML for the posting', () => {
  it('greenhouse (HTML-escaped content)', async () => {
    const escaped = BODY.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    route(() => json({ jobs: [{ absolute_url: 'https://acme.example/jobs?gh_jid=1', title: 'Engineer', location: { name: 'Zurich' }, first_published: '2026-10-01T00:00:00Z', content: escaped }] }))
    const [job] = await greenhouse.fetch('acme')
    expectWhole(job)
  })

  it('lever (opening, titled lists, closing) and its apply link', async () => {
    route(() =>
      json([
        {
          text: 'Engineer',
          hostedUrl: 'https://jobs.lever.co/acme/1',
          applyUrl: 'https://jobs.lever.co/acme/1/apply',
          descriptionPlain: 'plain',
          description: '<h2>About the role</h2><p>You will build the payments API with <a href="https://example.com/docs?utm_source=x">our docs</a> open all day.</p>',
          lists: [
            { text: 'What you will do', content: '<li>Own the ledger service end to end</li><li>Partner with Product &amp; Engineering</li>' },
            { text: 'Requirements', content: "<li>5+ years of Go or Rust</li><li>Bachelor's degree or equivalent experience</li>" },
          ],
          additional: '<p>Salary: $140,000 - $180,000 plus equity. Location: Zürich (Hybrid, 3 days).</p>',
          createdAt: 1_790_000_000_000,
          categories: { location: 'Zurich' },
        },
      ])
    )
    const [job] = await lever.fetch('acme')
    expectWhole(job)
    expect(job.applyUrl).toBe('https://jobs.lever.co/acme/1/apply')
    expect(postingCapture(job).apply_url).toBe('https://jobs.lever.co/acme/1/apply')
  })

  it('ashby', async () => {
    route(() => json({ jobs: [{ title: 'Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/1', location: 'Zurich', isListed: true, descriptionPlain: 'plain', descriptionHtml: BODY, applyUrl: 'https://jobs.ashbyhq.com/acme/1/application', publishedAt: '2026-10-01T00:00:00Z' }] }))
    const [job] = await ashby.fetch('acme')
    expectWhole(job)
    expect(postingCapture(job).apply_url).toBe('https://jobs.ashbyhq.com/acme/1/application')
  })

  it('workable', async () => {
    route(() => json({ jobs: [{ title: 'Engineer', shortcode: 'ABC123', url: 'https://apply.workable.com/j/ABC123', description: BODY, published_on: '2026-10-01' }] }))
    const [job] = await workable.fetch('acme')
    expectWhole(job)
  })

  it('recruitee (description and requirements)', async () => {
    const [first, ...rest] = BODY.split('<h3>Requirements</h3>')
    route(() => json({ offers: [{ title: 'Engineer', slug: 'engineer', status: 'published', careers_url: 'https://jobs.acme.example/o/engineer', description: first, requirements: `<h3>Requirements</h3>${rest.join('')}`, published_at: '2026-10-01T00:00:00Z' }] }))
    const [job] = await recruitee.fetch('acme')
    expectWhole(job)
  })

  it('personio (labelled sections)', async () => {
    const feed =
      '<workzag-jobs><position><id>7</id><name>Engineer</name><office>Zurich</office><createdAt>2026-10-01T00:00:00+0000</createdAt><jobDescriptions>' +
      `<jobDescription><name>Your role</name><value><![CDATA[${BODY}]]></value></jobDescription>` +
      '</jobDescriptions></position></workzag-jobs>'
    route(() => xml(feed))
    const [job] = await personio.fetch('acme')
    expectWhole(job, ['Your role'])
  })

  it('smartrecruiters (a detail read for each posting)', async () => {
    route((url) =>
      /\/postings\/\d+$/.test(url)
        ? json({ jobAd: { sections: { jobDescription: { text: BODY } } } })
        : json({ content: [{ id: '4001', name: 'Engineer', company: { identifier: 'acme' }, location: { city: 'Zurich', country: 'ch' }, releasedDate: '2026-10-01T00:00:00Z' }] })
    )
    const [job] = await smartrecruiters.fetch('acme')
    expectWhole(job)
  })
})

describe('a posting with no HTML', () => {
  it('keeps a listing snippet as partial, and no body as none with no hash', () => {
    const snippet = postingCapture({ url: 'https://x.example/1', description: 'A short snippet of the role.' })
    expect(snippet).toMatchObject({ description_md: 'A short snippet of the role.', description_state: 'partial', description_source: 'listing' })
    const none = postingCapture({ url: 'https://x.example/1' })
    expect(none).toEqual({ description_md: null, description_state: 'none', description_source: null, apply_url: null, description_md5: null })
  })

  it('does not call an apply link that is the posting\'s own address a different one', () => {
    expect(postingCapture({ url: 'https://x.example/1', applyUrl: 'https://x.example/1' }).apply_url).toBeNull()
  })
})
