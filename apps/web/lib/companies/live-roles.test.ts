import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_TARGETING } from '../targeting'

const { fetchMock, memo } = vi.hoisted(() => ({ fetchMock: vi.fn(), memo: new Map<string, unknown>() }))

// next/cache outside a request has no cache: a memo keyed like the real one (key parts and arguments).
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>, keys: string[]) => async (...a: unknown[]) => {
    const k = JSON.stringify([keys, a])
    if (!memo.has(k)) memo.set(k, await fn(...a))
    return memo.get(k)
  },
}))
vi.mock('../ats/index', async (orig) => {
  const actual = await orig<typeof import('../ats/index')>()
  return { ...actual, providers: { ...actual.providers, greenhouse: { ...actual.providers.greenhouse, fetch: fetchMock } } }
})
// The classifier is not what is under test: a marker in the title says what it would have read.
vi.mock('../jobs/classify', () => ({
  classifyJob: ({ title }: { title: string }) => ({
    jobFunction: /\[sales\]/.test(title) ? 'sales' : 'engineering',
    seniority: /\[junior\]/.test(title) ? 'junior' : 'senior',
    country: /\[DE\]/.test(title) ? 'DE' : 'US',
    language: 'en',
    isRemote: false,
  }),
}))

import { LIVE_PAGE_SIZE, liveRoles, type LiveCompany } from './live-roles'

const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
const targets = {
  targeting: { ...EMPTY_TARGETING, functions: ['engineering'], seniority: ['senior'], countries: ['US'], excludedKeywords: ['crypto'] },
  titles: [],
  version: 1,
}
const company: LiveCompany = {
  id: 'co-1',
  name: 'Acme',
  domain: 'acme.example',
  career_url: 'https://acme.example/careers',
  metadata: { ats: { provider: 'greenhouse', token: 'acme' } },
  employer_id: 'emp-1',
}

/** Every bucket is non-zero: 5 inside the targets (2 of them the person's), 55 outside. */
const KINDS: [string, number, (n: number) => Record<string, unknown>][] = [
  ['keep', 3, () => ({ title: 'Platform Engineer' })],
  ['held', 2, () => ({ title: 'Staff Platform Engineer' })],
  ['place', 11, () => ({ title: 'Platform Engineer [DE]' })],
  ['age', 7, () => ({ title: 'Platform Engineer', postedAt: ago(200) })],
  ['excluded', 9, () => ({ title: 'Platform Engineer, Crypto' })],
  ['level', 13, () => ({ title: 'Platform Engineer [junior]' })],
  ['title', 15, () => ({ title: 'Account Executive [sales]' })],
]

function listing() {
  const rows: { kind: string; job: Record<string, unknown> }[] = []
  for (const [kind, n, make] of KINDS) for (let i = 0; i < n; i++) rows.push({ kind, job: { externalId: `${kind}-${i}`, url: `https://acme.example/jobs/${kind}-${i}`, postedAt: ago(2), location: 'Remote', ...make(i) } })
  // The employer's order is not grouped by kind.
  return rows.sort((a, b) => ((a.job.externalId as string).length * 7 + (a.job.externalId as string).charCodeAt(0)) - ((b.job.externalId as string).length * 7 + (b.job.externalId as string).charCodeAt(0)))
}

function fakeDb(held: string[]) {
  const touched: string[] = []
  const rpcs: { name: string; args: Record<string, unknown> }[] = []
  const db = {
    from(table: string) {
      touched.push(table)
      const b = {
        select: () => b,
        eq: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => void) => resolve({ data: held.map((id) => ({ id: `job-${id}`, external_id: id })), error: null }),
      }
      return b
    },
    rpc: async (name: string, args: Record<string, unknown>) => (rpcs.push({ name, args }), { data: null, error: null }),
  }
  return { db: db as never, touched, rpcs }
}

beforeEach(() => {
  memo.clear()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => listing().map((r) => r.job))
})

describe('liveRoles', () => {
  it('counts every bucket and the roles inside the targets, and they add up to what the employer listed', async () => {
    const { db } = fakeDb(['held-0', 'held-1'])
    const out = await liveRoles({ db, userId: 'u1', company, targets })
    expect(out.total).toBe(60)
    expect(out.kept).toBe(5)
    expect(out.counts).toEqual({ place: 11, age: 7, excluded: 9, level: 13, title: 15 })
    expect(out.kept + Object.values(out.counts).reduce((a, b) => a + b, 0)).toBe(out.total)
    expect(out.tier).toBe('board')
    expect(out.window).toBe(false)
  })

  it('puts the person\'s own roles first, then the other roles inside their targets, then the rest 25 a page, each with its reason', async () => {
    const { db } = fakeDb(['held-0', 'held-1'])
    const first = await liveRoles({ db, userId: 'u1', company, targets })
    expect(first.rows).toHaveLength(LIVE_PAGE_SIZE)
    expect(first.pages).toBe(3)
    expect(first.rows.slice(0, 2).map((r) => r.jobId).sort()).toEqual(['job-held-0', 'job-held-1'])
    expect(first.rows.slice(0, 5).every((r) => r.reason === null)).toBe(true)
    expect(first.rows.slice(5).every((r) => r.reason !== null && r.jobId === null)).toBe(true)

    const last = await liveRoles({ db, userId: 'u1', company, targets, page: 2 })
    expect(last.rows).toHaveLength(10)
    expect(last.page).toBe(2)
    // a page past the end is the last page
    expect((await liveRoles({ db, userId: 'u1', company, targets, page: 99 })).page).toBe(2)
  })

  it('reads the employer once for ten minutes, however many pages are asked for', async () => {
    const { db } = fakeDb([])
    await liveRoles({ db, userId: 'u1', company, targets, page: 0 })
    await liveRoles({ db, userId: 'u1', company, targets, page: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stores nothing about the roles: it reads person_jobs and writes only the employer\'s open count', async () => {
    const { db, touched, rpcs } = fakeDb([])
    await liveRoles({ db, userId: 'u1', company, targets })
    expect(touched).toEqual(['person_jobs'])
    expect(rpcs).toEqual([{ name: 'set_employer_open_count', args: { p_employer: 'emp-1', p_count: 60 } }])
  })

  it('writes no open count for an employer that is not in the directory', async () => {
    const { db, rpcs } = fakeDb([])
    fetchMock.mockImplementation(async () => [])
    const out = await liveRoles({ db, userId: 'u1', company: { ...company, employer_id: null }, targets })
    expect(out).toMatchObject({ total: 0, kept: 0, rows: [], pages: 1 })
    expect(rpcs).toEqual([])
  })

  it('says why nothing was read, and does not throw, when the employer cannot be reached', async () => {
    const { db } = fakeDb([])
    fetchMock.mockRejectedValue(new Error('down'))
    const out = await liveRoles({ db, userId: 'u1', company, targets })
    expect(out).toMatchObject({ failure: 'unreachable', total: 0, tier: null })
  })

  it('keeps every listed role when the person has stated nothing', async () => {
    const { db } = fakeDb([])
    const out = await liveRoles({ db, userId: 'u1', company, targets: { targeting: EMPTY_TARGETING, titles: [] } })
    expect(out.kept).toBe(60)
    expect(out.counts).toEqual({ place: 0, age: 0, excluded: 0, level: 0, title: 0 })
  })
})
