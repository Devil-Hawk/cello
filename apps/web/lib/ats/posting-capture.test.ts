// What a read stores of one posting's body, and when it is read again: the hash is the md5 of the Markdown, so a
// posting that did not change is not re-extracted, a new heading is, no body is no body (never md5 of nothing),
// a listing's snippet is partial and never replaces a body already stored.

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emptyResult, syncJobs, type AtsStore, type CompanyInput, type ExistingJob, type JobUpdate, type JobUpsertRow } from './index'
import type { AtsJob } from './types'

const COMPANY: CompanyInput = { id: 'c1', name: 'Acme', domain: 'acme.com', career_url: 'https://acme.com/careers' }
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

const HTML = '<h2>About the role</h2><p>Build the ledger.</p><h3>Requirements</h3><ul><li>5+ years of Go</li><li>Strong SQL</li></ul>'
const MD = '## About the role\n\nBuild the ledger.\n\n### Requirements\n\n-   5+ years of Go\n-   Strong SQL'

// One instant for every posting, so the order a read stores them in does not depend on the millisecond each was made.
const POSTED = new Date(Date.now() - 86_400_000).toISOString()
const job = (over: Partial<AtsJob> = {}): AtsJob => ({
  title: 'Backend Engineer',
  url: 'https://acme.com/jobs/1',
  externalId: 'https://acme.com/jobs/1',
  description: 'About the role\nBuild the ledger.\nRequirements\n5+ years of Go\nStrong SQL',
  descriptionHtml: HTML,
  postedAt: POSTED,
  ...over,
})

const stored = (over: Partial<ExistingJob> = {}): ExistingJob => ({ externalId: 'https://acme.com/jobs/1', title: 'Backend Engineer', location: null, salaryRange: null, descriptionMd5: md5(MD), open: true, ...over })

async function run(listed: AtsJob[], have: ExistingJob[] = []) {
  const upserted: JobUpsertRow[] = []
  const updated: JobUpdate[] = []
  const store: AtsStore = {
    async listJobs() {
      return have
    },
    async upsertJobs(rows) {
      upserted.push(...rows)
    },
    async updateJobs(rows) {
      updated.push(...rows)
      return rows.length
    },
    async saveCompanyMetadata() {},
    async updateCompanyLastScraped() {},
    async clearBoardJobs() {
      return { deleted: 0, closed: 0 }
    },
  }
  await syncJobs(store, COMPANY, listed, { source: 'greenhouse', sightingSources: ['greenhouse'], stored: new Map(have.map((h) => [h.externalId, h])) }, emptyResult(COMPANY))
  return { upserted, updated }
}

describe('a new role keeps the employer\'s whole posting', () => {
  it('stores the Markdown with its hash, the state and where it came from, beside the capped plain copy', async () => {
    const { upserted } = await run([job({ descriptionSource: 'jsonld', applyUrl: 'https://apply.acme.com/1' })])
    const row = upserted[0]
    expect(row.description_md).toBe(MD)
    expect(row.description_md5).toBe(md5(MD))
    expect(row).toMatchObject({ description_state: 'full', description_source: 'jsonld', apply_url: 'https://apply.acme.com/1' })
    expect(row.description).toContain('Build the ledger.')
    expect(row.description).not.toContain('##')
  })

  it('stores a hash that equals the md5 of the stored Markdown on every row, and none without a body', async () => {
    const { upserted } = await run([job(), job({ url: 'https://acme.com/jobs/2', externalId: 'https://acme.com/jobs/2', title: 'Data Engineer', descriptionHtml: '<p>Second.</p>', description: 'Second.' }), job({ url: 'https://acme.com/jobs/3', externalId: 'https://acme.com/jobs/3', title: 'Platform Engineer', descriptionHtml: undefined, description: undefined })])
    for (const row of upserted) {
      if (row.description_md) expect(row.description_md5).toBe(md5(row.description_md))
      else expect(row.description_md5).toBeNull()
    }
    expect(upserted[2]).toMatchObject({ description_md: null, description_state: 'none', description_source: null, description_md5: null })
  })

  it('reads the requirements one by one, each quote verbatim in the stored Markdown', async () => {
    const { upserted } = await run([job()])
    const req = upserted[0].requirements as { version: number; items: { text: string; quote: string }[] }
    expect(req.version).toBe(2)
    expect(req.items.map((i) => i.text)).toEqual(['5+ years of Go', 'Strong SQL'])
    for (const i of req.items) expect(upserted[0].description_md).toContain(i.quote)
  })

  it('marks a listing\'s snippet partial, whatever the tier', async () => {
    const { upserted } = await run([job({ descriptionHtml: undefined, description: 'A one-line snippet from a listing.' })])
    expect(upserted[0]).toMatchObject({ description_md: 'A one-line snippet from a listing.', description_state: 'partial', description_source: 'listing' })
  })
})

describe('a stored role is re-read only when its Markdown changes', () => {
  it('leaves an unchanged posting alone', async () => {
    const { updated } = await run([job()], [stored()])
    expect(updated).toEqual([])
  })

  it('re-extracts when a heading is added, and writes the new hash with the body', async () => {
    const changed = HTML + '<h3>Benefits</h3><p>Equity.</p>'
    const { updated } = await run([job({ descriptionHtml: changed })], [stored()])
    expect(updated).toHaveLength(1)
    const f = updated[0].fields
    expect(String(f.description_md)).toContain('### Benefits')
    expect(f.description_md5).toBe(md5(String(f.description_md)))
    expect(f.description_md5).not.toBe(md5(MD))
    expect((f.requirements as { version: number }).version).toBe(2)
    expect(typeof f.requirements_extracted_at).toBe('string')
  })

  it('captures a stored role that has no body yet, from its next read', async () => {
    const { updated } = await run([job()], [stored({ descriptionMd5: null })])
    expect(updated[0].fields).toMatchObject({ description_md: MD, description_state: 'full', description_md5: md5(MD) })
  })

  it('never replaces a body with a snippet, and never blanks it when a read found none', async () => {
    const snippet = await run([job({ descriptionHtml: undefined, description: 'Just a snippet.' })], [stored()])
    expect(snippet.updated).toEqual([])
    const nothing = await run([job({ descriptionHtml: undefined, description: undefined })], [stored()])
    expect(nothing.updated).toEqual([])
  })

  it('lets a snippet stand in for a role that has no body at all', async () => {
    const { updated } = await run([job({ descriptionHtml: undefined, description: 'Just a snippet.' })], [stored({ descriptionMd5: null })])
    expect(updated[0].fields).toMatchObject({ description_md: 'Just a snippet.', description_state: 'partial' })
  })
})
