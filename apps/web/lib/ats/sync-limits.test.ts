// What syncJobs keeps, for any source: the employer's own, open, unique and real
// roles, at most 200 open rows per company, the ones inside the person's targets
// first. Sightings still use everything the source listed.

import { describe, expect, it } from 'vitest'
import { emptyResult, syncJobs, type AtsStore, type CompanyInput, type ExistingJob, type JobUpsertRow } from './index'
import type { AtsJob } from './types'
import { EMPTY_TARGETING } from '../targeting'

const COMPANY: CompanyInput = { id: 'c1', name: 'Acme', domain: 'acme.com', career_url: 'https://acme.com/careers' }
const judge = { name: 'Acme', domain: 'acme.com', careerUrl: 'https://acme.com/careers' }
const day = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * day).toISOString()

function memory(existing: ExistingJob[] = [], keep: (id: string) => boolean = () => false) {
  const upserted: JobUpsertRow[] = []
  const evictAsked: string[][] = []
  const sightings: { ids: string[]; sources: string[] }[] = []
  const store: AtsStore = {
    async listJobs() {
      return existing
    },
    async evictJobs(_c, ids) {
      evictAsked.push(ids)
      return ids.filter((id) => !keep(id))
    },
    async upsertJobs(rows) {
      upserted.push(...rows)
    },
    async updateJobs(rows) {
      return rows.length
    },
    async recordSightings(_c, ids, sources) {
      sightings.push({ ids, sources })
      return { seen: ids.length, reopened: 0, missed: 0, closed: 0 }
    },
    async saveCompanyMetadata() {},
    async updateCompanyLastScraped() {},
    async clearBoardJobs() {
      return { deleted: 0, closed: 0 }
    },
  }
  return { store, upserted, sightings, evictAsked }
}

const role = (n: number, over: Partial<AtsJob> = {}): AtsJob => ({
  title: `Software Engineer ${n}`,
  url: `https://acme.com/jobs/${n}`,
  externalId: `https://acme.com/jobs/${n}`,
  location: `City ${n}`,
  postedAt: ago(1),
  description: 'Build things.',
  ...over,
})

async function run(listed: AtsJob[], existing: ExistingJob[] = [], opts: Partial<Parameters<typeof syncJobs>[3]> = {}, keep?: (id: string) => boolean) {
  const m = memory(existing, keep)
  const result = emptyResult(COMPANY)
  await syncJobs(m.store, COMPANY, listed, { source: 'sitemap', sightingSources: ['sitemap'], stored: new Map(existing.map((e) => [e.externalId, e])), judge, ...opts }, result)
  return { ...m, result }
}

describe('syncJobs: at most 200 open roles per company', () => {
  it('719 listed roles: 200 stored, the ones inside the targets first, and sightings still get all 719', async () => {
    const listed: AtsJob[] = []
    // 600 marketing roles, newest, and 119 engineering roles, older: engineering is what the person asked for.
    for (let i = 0; i < 600; i++) listed.push(role(i, { title: `Brand Marketing Manager ${i}`, postedAt: ago(1) }))
    for (let i = 600; i < 719; i++) listed.push(role(i, { title: `Data Engineer ${i}`, postedAt: ago(20) }))
    const { upserted, sightings, result } = await run(listed, [], { targeting: { ...EMPTY_TARGETING, functions: ['engineering', 'data'] } })

    expect(upserted).toHaveLength(200)
    expect(upserted.filter((r) => /Data Engineer/.test(r.title))).toHaveLength(119)
    expect(result.excluded?.capped).toBe(719 - 200)
    expect(sightings[0].ids).toHaveLength(719)
  })

  it('counts the open rows already stored against the cap', async () => {
    const existing: ExistingJob[] = Array.from({ length: 190 }, (_, i) => ({
      externalId: `https://acme.com/old/${i}`,
      title: `Old role ${i}`,
      location: `Elsewhere ${i}`,
      salaryRange: null,
      descriptionMd5: 'x',
      source: 'sitemap',
      open: true,
    }))
    const listed = Array.from({ length: 30 }, (_, i) => role(i))
    const { upserted } = await run(listed, existing)
    expect(upserted).toHaveLength(10)
  })

  describe('closed rows count against the cap', () => {
    const closed = (n: number): ExistingJob[] =>
      Array.from({ length: n }, (_, i) => ({
        externalId: `https://acme.com/gone/${i}`,
        title: `Gone role ${i}`,
        location: `Elsewhere ${i}`,
        salaryRange: null,
        descriptionMd5: 'x',
        source: 'sitemap',
        open: false,
        lastSeenAt: ago(10 + i),
      }))

    it('200 closed rows plus 300 new roles never leave more than 200 rows', async () => {
      const listed = Array.from({ length: 300 }, (_, i) => role(i))
      const { upserted, evictAsked, result } = await run(listed, closed(200))
      expect(evictAsked[0]).toHaveLength(200)
      expect(200 - evictAsked[0].length + upserted.length).toBeLessThanOrEqual(200)
      expect(upserted).toHaveLength(200)
      expect(result.evicted).toBe(200)
    })

    it('a closed row something points at stays and still counts', async () => {
      const listed = Array.from({ length: 300 }, (_, i) => role(i))
      const { upserted } = await run(listed, closed(200), {}, (id) => id.endsWith('/gone/0') || id.endsWith('/gone/1'))
      expect(2 + upserted.length).toBeLessThanOrEqual(200)
    })

    it('a store that cannot evict still keeps the total at 200', async () => {
      const m = memory(closed(200))
      delete (m.store as { evictJobs?: unknown }).evictJobs
      const result = emptyResult(COMPANY)
      await syncJobs(m.store, COMPANY, [role(1)], { source: 'sitemap', sightingSources: [], stored: new Map(closed(200).map((e) => [e.externalId, e])), judge }, result)
      expect(m.upserted).toHaveLength(0)
    })
  })

  describe('a full company still takes a role inside the targets', () => {
    const targeting = { ...EMPTY_TARGETING, functions: ['engineering', 'data'] }
    const full = (n = 200, over: Partial<ExistingJob> = {}): ExistingJob[] =>
      Array.from({ length: n }, (_, i) => ({
        externalId: `https://acme.com/old/${i}`,
        title: `Office Manager ${i}`,
        location: `Elsewhere ${i}`,
        salaryRange: null,
        descriptionMd5: 'x',
        source: 'sitemap',
        open: true,
        jobFunction: 'operations',
        seniority: 'mid',
        postedAt: ago(30),
        ...over,
      }))
    const inTarget = (n: number) => role(n, { title: `Software Engineer II, Data Platform ${n}`, postedAt: ago(0) })

    it('200 stored roles outside the targets give up one for a new role inside them', async () => {
      const { upserted, evictAsked, result } = await run([inTarget(1)], full(), { targeting })
      expect(upserted.map((r) => r.external_id)).toEqual(['https://acme.com/jobs/1'])
      expect(evictAsked).toHaveLength(1)
      expect(evictAsked[0]).toHaveLength(1)
      expect(result.evicted).toBe(1)
      expect(result.excluded?.capped).toBe(0)
    })

    it('gives up as many as come in, never more than 200 stay open', async () => {
      const { upserted, evictAsked } = await run([inTarget(1), inTarget(2), inTarget(3)], full(), { targeting })
      expect(upserted).toHaveLength(3)
      expect(evictAsked[0]).toHaveLength(3)
      expect(200 - evictAsked[0].length + upserted.length).toBe(200)
    })

    it('a stored role something points at is not given up, and no extra role is stored for it', async () => {
      const { upserted, result } = await run([inTarget(1), inTarget(2)], full(), { targeting }, () => true)
      expect(upserted).toHaveLength(0)
      expect(result.excluded?.capped).toBe(2)
    })

    it('stored roles inside the targets are never swapped for new ones outside them or no newer', async () => {
      const mine = full(200, { title: 'Data Engineer', jobFunction: 'data', postedAt: ago(0) }).map((e, i) => ({ ...e, title: `Data Engineer ${i}` }))
      const listed = [{ ...inTarget(1), postedAt: ago(1) }, role(2, { title: 'Brand Marketing Manager', postedAt: ago(0) })]
      const { upserted, evictAsked } = await run(listed, mine, { targeting })
      expect(upserted).toHaveLength(0)
      expect(evictAsked).toHaveLength(0)
    })

    it('a store that cannot evict simply drops what does not fit', async () => {
      const m = memory(full())
      delete (m.store as { evictJobs?: unknown }).evictJobs
      const result = emptyResult(COMPANY)
      await syncJobs(m.store, COMPANY, [inTarget(1)], { source: 'sitemap', sightingSources: [], stored: new Map(full().map((e) => [e.externalId, e])), judge, targeting }, result)
      expect(m.upserted).toHaveLength(0)
      expect(result.excluded?.capped).toBe(1)
    })
  })

  it('cuts a description at 20,000 characters', async () => {
    const { upserted } = await run([role(1, { description: 'x'.repeat(50_000) })])
    expect(upserted[0].description).toHaveLength(20_000)
  })
})

describe('syncJobs: only the employer own, open, unique and real roles', () => {
  it('keeps one role per requisition and per title plus location across sources', async () => {
    const existing: ExistingJob[] = [
      { externalId: 'https://boards.example/old', title: 'Software Engineer 1', location: 'City 1', salaryRange: null, descriptionMd5: null, source: 'scraper', open: true },
    ]
    const listed = [role(1), role(2, { requisitionId: 'R-9' }), role(3, { requisitionId: 'r-9', title: 'Something else' })]
    const { upserted, result } = await run(listed, existing, { source: 'greenhouse' })
    expect(upserted.map((r) => r.external_id)).toEqual(['https://acme.com/jobs/2'])
    expect(result.excluded?.duplicate).toBe(2)
  })

  it('drops agency, reposting, expired, talent community and non-role postings, and counts each', async () => {
    const listed = [
      role(1, { employer: 'Robert Half' }),
      role(2, { url: 'https://www.linkedin.com/jobs/view/2', externalId: 'https://www.linkedin.com/jobs/view/2' }),
      role(3, { validThrough: ago(2) }),
      role(4, { title: 'Join our Talent Community' }),
      role(5, { isEvent: true }),
      role(6),
    ]
    const { upserted, result } = await run(listed)
    expect(upserted.map((r) => r.external_id)).toEqual(['https://acme.com/jobs/6'])
    expect(result.excluded).toMatchObject({ agency: 1, reposting: 1, expired: 1, non_role: 2, capped: 0 })
  })

  it('a role older than 180 days is not stored (the freshness rule holds on every source)', async () => {
    const { upserted, result } = await run([role(1, { postedAt: ago(200) }), role(2)])
    expect(upserted).toHaveLength(1)
    expect(result.found).toBe(1)
  })
})

describe('syncJobs: a role that is no longer open or no longer the employer\'s is not sighted, so it closes', () => {
  const storedOpen = (n: number): ExistingJob => ({
    externalId: `https://acme.com/jobs/${n}`,
    title: `Software Engineer ${n}`,
    location: `City ${n}`,
    salaryRange: null,
    descriptionMd5: null,
    source: 'sitemap',
    open: true,
  })

  it('a stored open role relisted with validThrough in the past is left out of the sightings', async () => {
    const { sightings, upserted } = await run([role(1, { validThrough: ago(1) }), role(2)], [storedOpen(1)])
    expect(upserted.map((r) => r.external_id)).toEqual(['https://acme.com/jobs/2'])
    expect(sightings[0].ids).toEqual(['https://acme.com/jobs/2'])
  })

  it('the same holds when the source gives its own listed ids, and for an agency or a reposting site', async () => {
    const repost = 'https://www.linkedin.com/jobs/view/3'
    const listed = [role(1, { validThrough: ago(1) }), role(2, { employer: 'Robert Half' }), role(3, { url: repost, externalId: repost }), role(4)]
    const ids = listed.map((j) => j.externalId).concat('https://acme.com/jobs/unread')
    const { sightings } = await run(listed, [storedOpen(1), storedOpen(2)], { listedIds: ids })
    expect(sightings[0].ids).toEqual(['https://acme.com/jobs/4', 'https://acme.com/jobs/unread'])
  })

  it('when every listed role is expired the answer is still recorded, so the stored one can close', async () => {
    const { sightings } = await run([role(1, { validThrough: ago(1) })], [storedOpen(1)])
    expect(sightings[0].ids).toEqual([])
  })

  it('an expired role is not updated either', async () => {
    const m = memory([storedOpen(1)])
    const updates: unknown[] = []
    m.store.updateJobs = async (rows) => {
      updates.push(...rows)
      return rows.length
    }
    const result = emptyResult(COMPANY)
    await syncJobs(m.store, COMPANY, [role(1, { validThrough: ago(1), title: 'Staff Software Engineer 1' }), role(2)], { source: 'sitemap', sightingSources: ['sitemap'], stored: new Map([[ 'https://acme.com/jobs/1', storedOpen(1)]]), judge }, result)
    expect(updates).toEqual([])
  })
})

describe('syncJobs: a reposting site is never the employer\'s own, even when the careers link is on it', () => {
  const builtin = { name: 'Acme', domain: 'acme.com', careerUrl: 'https://builtin.com/company/acme/jobs' }
  const onBuiltin = (n: number) => role(n, { url: `https://builtin.com/job/${n}`, externalId: `https://builtin.com/job/${n}` })

  it('roles on builtin.com are not stored when the careers URL is builtin.com', async () => {
    const { upserted, result } = await run([onBuiltin(1), onBuiltin(2)], [], { judge: builtin })
    expect(upserted).toEqual([])
    expect(result.excluded?.reposting).toBe(2)
  })

  it('and a linkedin.com careers link keeps no linkedin.com role', async () => {
    const li = { name: 'Acme', domain: 'acme.com', careerUrl: 'https://www.linkedin.com/jobs/search/?keywords=acme' }
    const job = role(1, { url: 'https://www.linkedin.com/jobs/view/123456', externalId: 'https://www.linkedin.com/jobs/view/123456' })
    const { upserted } = await run([job], [], { judge: li })
    expect(upserted).toEqual([])
  })
})

describe('syncJobs: a windowed read closes nothing', () => {
  it('a search that lists only what matched records no misses', async () => {
    const { sightings } = await run([role(1)], [], { windowed: true })
    expect(sightings[0].sources).toEqual([])
  })

  it('a sitemap that lists more than it read gives sightings the whole list', async () => {
    const { sightings } = await run([role(1)], [], { listedIds: ['https://acme.com/jobs/1', 'https://acme.com/jobs/2', 'https://acme.com/jobs/3'] })
    expect(sightings[0]).toEqual({ ids: ['https://acme.com/jobs/1', 'https://acme.com/jobs/2', 'https://acme.com/jobs/3'], sources: ['sitemap'] })
  })
})
