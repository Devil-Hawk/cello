import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  adapters: ['themuse', 'remoteok', 'ycombinator', 'jobicy', 'himalayas', 'arbeitnow'].map((id) => ({ id })),
  queryAllSources: vi.fn(),
  ingestLeads: vi.fn(),
  discover: vi.fn(),
  alive: 0,
  peak: 0,
}))

vi.mock('@/lib/sources', () => ({
  sourceAdapters: h.adapters,
  queryAllSources: h.queryAllSources,
  ingestLeads: h.ingestLeads,
}))
vi.mock('@/lib/search/job-discovery', () => ({ discoverJobsViaWebSearch: h.discover }))

import { makeFakeAdmin } from './testing/fake-admin'
import { sourceRoles } from './sources'

const lead = (company: string, title: string, source: string) => ({
  company,
  title,
  url: `https://${company.toLowerCase()}.test/${title.replace(/\s/g, '-')}`,
  location: 'Remote',
  salary: null,
  description: 'Build things.',
  source,
  externalId: `${company}-${title}`,
})

const admin = () => makeFakeAdmin({ profiles: [{ id: 'u1', resume_text: 'Senior product manager', preferences: {} }] })
const input = (over = {}) => ({ admin: admin(), userId: 'u1', query: 'product manager', limit: 3, deadlineAt: Date.now() + 60_000, ...over })

beforeEach(() => {
  h.queryAllSources.mockReset()
  h.ingestLeads.mockReset()
  h.discover.mockReset().mockResolvedValue({ leads: [], notes: 'skipped' })
  h.alive = 0
  h.peak = 0
  h.ingestLeads.mockImplementation(async (_a: unknown, _u: string, leads: unknown[]) => ({ jobIds: leads.map((_, i) => `job-${i}`), found: leads.length, inserted: leads.length, createdCompanies: 0, errors: [] }))
})

describe('sourceRoles', () => {
  it('asks every source on its own, no more than four at once', async () => {
    h.queryAllSources.mockImplementation(async (_q: unknown, opts: { only: string[] }) => {
      h.alive += 1
      h.peak = Math.max(h.peak, h.alive)
      await new Promise((r) => setTimeout(r, 20))
      h.alive -= 1
      return { leads: [lead(`Co-${opts.only[0]}`, 'Product Manager', opts.only[0])], perSource: {} }
    })
    const out = await sourceRoles(input())
    const asked = h.queryAllSources.mock.calls.map((c) => (c[1] as { only: string[] }).only[0]).sort()
    expect(asked).toEqual(['arbeitnow', 'himalayas', 'jobicy', 'remoteok', 'themuse', 'ycombinator'])
    expect(h.peak).toBeLessThanOrEqual(4)
    expect(h.peak).toBeGreaterThanOrEqual(2)
    expect(out.counts).toEqual({ ok: 6, partial: 0, failed: 0 })
    expect(out.perSource.themuse).toEqual({ found: 1, error: undefined })
  })

  it('one source failing does not stop the rest, and the failure is reported', async () => {
    h.queryAllSources.mockImplementation(async (_q: unknown, opts: { only: string[] }) => {
      if (opts.only[0] === 'remoteok') throw new Error('remoteok is down')
      return { leads: [lead(`Co-${opts.only[0]}`, 'Product Manager', opts.only[0])], perSource: {} }
    })
    const out = await sourceRoles(input())
    expect(out.counts.failed).toBe(1)
    expect(out.counts.ok).toBe(5)
    expect(out.perSource.remoteok.error).toMatch(/down/)
    expect(out.jobIds.length).toBe(5)
  })

  it('drops roles at companies the person excluded', async () => {
    const a = makeFakeAdmin({ profiles: [{ id: 'u1', resume_text: 'PM', preferences: { targeting: { excludedCompanies: ['badco'] } } }] })
    h.queryAllSources.mockImplementation(async (_q: unknown, opts: { only: string[] }) => ({
      leads: opts.only[0] === 'themuse' ? [lead('BadCo', 'Product Manager', 'themuse'), lead('GoodCo', 'Product Manager', 'themuse')] : [],
      perSource: {},
    }))
    await sourceRoles(input({ admin: a }))
    const ingested = h.ingestLeads.mock.calls[0][2] as { company: string }[]
    expect(ingested.map((l) => l.company)).toEqual(['GoodCo'])
  })

  it('widens the search when the first pass is thin, then stops', async () => {
    h.queryAllSources.mockResolvedValue({ leads: [], perSource: {} })
    h.ingestLeads.mockResolvedValue({ jobIds: [], found: 0, inserted: 0, createdCompanies: 0, errors: [] })
    const out = await sourceRoles(input({ limit: 5 }))
    // One baseline pass plus the broadening steps that apply, each over every source.
    const rounds = h.queryAllSources.mock.calls.length / 6
    expect(rounds).toBeGreaterThanOrEqual(1)
    expect(rounds).toBeLessThanOrEqual(4)
    expect(out.notes[0]).toMatch(/Searched the job sources/)
  })

  it('does not widen once it has enough, and falls to the open web only when short', async () => {
    h.queryAllSources.mockResolvedValue({ leads: [lead('Co', 'Product Manager', 'themuse')], perSource: {} })
    h.ingestLeads.mockResolvedValue({ jobIds: Array.from({ length: 25 }, (_, i) => `j${i}`), found: 25, inserted: 25, createdCompanies: 0, errors: [] })
    await sourceRoles(input({ limit: 20 }))
    expect(h.queryAllSources.mock.calls.length).toBe(6)
    expect(h.discover).not.toHaveBeenCalled()
  })

  it('starts nothing past the deadline', async () => {
    h.queryAllSources.mockResolvedValue({ leads: [], perSource: {} })
    const out = await sourceRoles(input({ deadlineAt: Date.now() - 1 }))
    expect(h.queryAllSources).not.toHaveBeenCalled()
    expect(out.counts.partial).toBe(6)
  })

  it('reports each branch to the task tree', async () => {
    h.queryAllSources.mockResolvedValue({ leads: [lead('Co', 'Product Manager', 'themuse')], perSource: {} })
    const events: string[] = []
    await sourceRoles(input({ limit: 1, onBranch: (e: { phase: string; item: string }) => void events.push(`${e.phase}:${e.item}`) }))
    expect(events.filter((e) => e.startsWith('start:'))).toHaveLength(6)
    expect(events.filter((e) => e.startsWith('end:'))).toHaveLength(6)
  })
})
