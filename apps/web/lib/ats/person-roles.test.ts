// What a read keeps for a person (directive 26): with targets stated, only the roles inside them are
// stored and the person gets a person_roles row for each; the rest are counted by reason and never
// stored. With none stated the followed employer keeps up to the cap, marked as version 0.

import { describe, expect, it } from 'vitest'
import { emptyResult, syncJobs, tierOfSource, type AtsStore, type CompanyInput, type CountWrite, type JobUpsertRow } from './index'
import type { AtsJob } from './types'
import { EMPTY_TARGETING } from '../targeting'

const COMPANY: CompanyInput = { id: 'c1', name: 'Acme', domain: 'acme.com', career_url: 'https://acme.com/careers', user_id: 'u1', employer_id: 'e1' }
const day = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * day).toISOString()

function memory() {
  const upserted: JobUpsertRow[] = []
  const kept: { userId: string; companyId: string; externalIds: string[]; hiddenIds: string[]; targetsVersion: number }[] = []
  const counts: { userId: string; rows: CountWrite[] }[] = []
  const store: AtsStore = {
    async listJobs() {
      return []
    },
    async upsertJobs(rows) {
      upserted.push(...rows)
    },
    async updateJobs(rows) {
      return rows.length
    },
    async keepForPerson(input) {
      kept.push(input)
    },
    async setCounts(userId, rows) {
      counts.push({ userId, rows })
    },
    async saveCompanyMetadata() {},
    async updateCompanyLastScraped() {},
    async clearBoardJobs() {
      return { deleted: 0, closed: 0 }
    },
  }
  return { store, upserted, kept, counts }
}

const role = (n: number, title: string, over: Partial<AtsJob> = {}): AtsJob => ({
  title,
  url: `https://acme.com/jobs/${n}`,
  externalId: `https://acme.com/jobs/${n}`,
  description: 'Build things.',
  postedAt: ago(2),
  ...over,
})

async function run(listed: AtsJob[], opts: Partial<Parameters<typeof syncJobs>[3]> = {}) {
  const m = memory()
  const result = emptyResult(COMPANY)
  await syncJobs(m.store, COMPANY, listed, { source: 'greenhouse', sightingSources: ['greenhouse'], stored: new Map(), owner: { userId: 'u1', targetsVersion: 4 }, ...opts }, result)
  return { ...m, result }
}

const countOf = (rows: CountWrite[], reason: string) => rows.find((r) => r.reason === reason)?.n

describe('syncJobs: store only what is inside the person\'s targets', () => {
  const listed = [
    role(1, 'Backend Engineer'),
    role(2, 'Account Executive'),
    role(3, 'Legal Counsel'),
    role(4, 'Senior Backend Engineer'),
  ]

  it('stores the roles inside the targets, gives them to the person, and counts the rest by reason', async () => {
    const { upserted, kept, counts, result } = await run(listed, { targeting: { ...EMPTY_TARGETING, functions: ['engineering'] } })
    expect(upserted.map((r) => r.title).sort()).toEqual(['Backend Engineer', 'Senior Backend Engineer'])
    expect(result.inserted).toBe(2)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ userId: 'u1', companyId: 'c1', hiddenIds: [], targetsVersion: 4 })
    expect(kept[0].externalIds.sort()).toEqual(['https://acme.com/jobs/1', 'https://acme.com/jobs/4'])
    // the two outside roles are a number, not rows
    expect(counts).toHaveLength(1)
    expect(counts[0].userId).toBe('u1')
    expect(countOf(counts[0].rows, 'title')).toBe(2)
    expect(counts[0].rows.every((r) => r.kind === 'outside_targets' && r.employer_id === 'e1' && r.company_id === null)).toBe(true)
  })

  it('sends every reason, so a zero resets the day\'s number', async () => {
    const { counts } = await run(listed, { targeting: { ...EMPTY_TARGETING, functions: ['engineering'] } })
    expect(counts[0].rows.map((r) => r.reason).sort()).toEqual(['age', 'excluded', 'level', 'place', 'title'])
    expect(countOf(counts[0].rows, 'place')).toBe(0)
  })

  it('counts a role posted more than 180 days ago as age, and does not store it', async () => {
    const { upserted, counts } = await run([role(1, 'Backend Engineer'), role(5, 'Backend Engineer II', { postedAt: ago(400) })], { targeting: { ...EMPTY_TARGETING, functions: ['engineering'] } })
    expect(upserted.map((r) => r.title)).toEqual(['Backend Engineer'])
    expect(countOf(counts[0].rows, 'age')).toBe(1)
  })

  it('counts an excluded word as excluded', async () => {
    const { upserted, counts } = await run([role(1, 'Backend Engineer'), role(6, 'Backend Engineer, Gambling')], { targeting: { ...EMPTY_TARGETING, functions: ['engineering'], excludedKeywords: ['gambling'] } })
    expect(upserted.map((r) => r.title)).toEqual(['Backend Engineer'])
    expect(countOf(counts[0].rows, 'excluded')).toBe(1)
  })

  it('keeps a role hidden when nothing disagrees but its place could not be read', async () => {
    const { upserted, kept } = await run([role(1, 'Backend Engineer'), role(7, 'Backend Engineer, Payments', { location: 'Berlin, Germany' })], {
      targeting: { ...EMPTY_TARGETING, functions: ['engineering'], countries: ['US'] },
    })
    // the role in Germany is outside (place); the one with no place is kept hidden
    expect(upserted.map((r) => r.title)).toEqual(['Backend Engineer'])
    expect(kept[0].hiddenIds).toEqual(['https://acme.com/jobs/1'])
  })

  it('decides by the typed titles too: a title that matches none is counted as not one of theirs', async () => {
    const { upserted, counts } = await run([role(1, 'Backend Engineer'), role(2, 'Brand Marketing Manager')], { titles: ['Backend Engineer'] })
    expect(upserted.map((r) => r.title)).toEqual(['Backend Engineer'])
    expect(countOf(counts[0].rows, 'title')).toBe(1)
  })

  it('with no targets stated, keeps everything up to the cap, under version 0, and counts nothing', async () => {
    const { upserted, kept, counts } = await run(listed, { targeting: EMPTY_TARGETING })
    expect(upserted).toHaveLength(4)
    expect(kept[0].targetsVersion).toBe(0)
    expect(counts).toEqual([])
  })

  it('stores nothing per person without an owner, as before', async () => {
    const { upserted, kept, counts } = await run(listed, { owner: undefined, targeting: { ...EMPTY_TARGETING, functions: ['engineering'] } })
    expect(upserted).toHaveLength(4)
    expect(kept).toEqual([])
    expect(counts).toEqual([])
  })

  it('writes the tier the reader read it with', async () => {
    const { upserted } = await run([role(1, 'Backend Engineer')])
    expect(upserted[0].source_tier).toBe('board')
    expect(tierOfSource('site_search')).toBe('site_search')
    expect(tierOfSource('scraper')).toBe('rendered')
    expect(tierOfSource('workday')).toBe('board')
  })

  it('does not fail the read when the person roles cannot be written', async () => {
    const m = memory()
    m.store.keepForPerson = async () => {
      throw new Error('boom')
    }
    const result = emptyResult(COMPANY)
    await syncJobs(m.store, COMPANY, listed, { source: 'greenhouse', sightingSources: ['greenhouse'], stored: new Map(), owner: { userId: 'u1', targetsVersion: 1 }, targeting: { ...EMPTY_TARGETING, functions: ['engineering'] } }, result)
    expect(result.inserted).toBe(2)
    expect(result.errors.some((e) => e.startsWith('person roles failed'))).toBe(true)
    expect(result.errors.some((e) => e.startsWith('upsert failed'))).toBe(false)
  })
})
