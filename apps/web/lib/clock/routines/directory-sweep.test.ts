import { describe, expect, it, vi } from 'vitest'
import { fakeDb } from '../../companies/fake-db'
import type { RoutineContext, RoutineRow } from '../routines'
import type { WikidataEntity } from '../../companies/wikidata'
import { BOARDS_PER_SLICE, CANDIDATES_PER_SLICE, sweepWith, type SweepDeps } from './directory-sweep'

const NOW = Date.now()
const row: RoutineRow = { id: 'r1', user_id: null, command: 'directory.sweep', args: {}, local_time: null, every: '00:30:00', timezone: 'UTC', next_due_at: null, enabled: true, slice: null }
const job = (daysAgo: number, i = 0) => ({ title: `Engineer ${i}`, url: `https://boards.example/${i}`, externalId: `${i}`, postedAt: new Date(NOW - daysAgo * 86_400_000).toISOString() })

const candidate = (i: number) => ({ id: `c${i}`, name: `Gusto ${i}`, domain: null, ats_provider: 'greenhouse', ats_token: `gusto-${i}`, source: 'kalil', failed_reads: 0, state: 'pending' })
const board = (i: number) => ({ id: `e${i}`, name: `Acme ${i}`, ats_provider: 'greenhouse', ats_token: `acme-${i}` })

function setup(o: { candidates?: number; boards?: number; now?: () => number; deadlineAt?: number; readFails?: Set<string>; rpcError?: string; directory?: Record<string, unknown>[]; wikidata?: SweepDeps['wikidata'] } = {}) {
  const calls: string[] = []
  const reads: string[] = []
  const rpc: Record<string, (a: Record<string, unknown>) => unknown> = {
    directory_candidates_due: (a) => (calls.push(`candidates:${a.p_limit}`), o.rpcError === 'candidates' ? null : Array.from({ length: o.candidates ?? 0 }, (_, i) => candidate(i))),
    directory_boards_due: (a) => (calls.push(`boards:${a.p_limit}`), Array.from({ length: o.boards ?? 0 }, (_, i) => board(i))),
  }
  const { client, tables } = fakeDb({ directory_candidates: Array.from({ length: o.candidates ?? 0 }, (_, i) => candidate(i)), ...(o.directory ? { company_directory: o.directory } : {}) }, { rpc })
  const deps: SweepDeps = {
    verify: { now: () => NOW, fetchBoard: async () => [job(2, 1)], identify: async (_p, t) => ({ name: `Gusto ${t.split('-')[1]}`, homeUrls: [] }), pageBoards: async () => [] },
    people: async () => [],
    read: async (_db, employer) => {
      reads.push(employer.id)
      if (o.readFails?.has(employer.id)) return { listed: 0, kept: 0, stored: 0, failure: 'cannot_read', errors: [] }
      return { listed: 10, kept: 2, stored: 1, errors: [] }
    },
    wikidata: o.wikidata ?? (async () => []),
  }
  const ctx: RoutineContext = { admin: client, routine: row, userId: null, state: null, now: o.now ?? (() => NOW), deadlineAt: o.deadlineAt ?? NOW + 200_000 }
  return { ctx, deps, calls, reads, tables }
}

describe('directory.sweep', () => {
  it('verifies candidates first and then reads the boards that are due, in one slice', async () => {
    const { ctx, deps, calls, reads, tables } = setup({ candidates: 3, boards: 2 })
    const r = await sweepWith(ctx, deps)
    expect(calls).toEqual([`candidates:${CANDIDATES_PER_SLICE}`, `boards:${BOARDS_PER_SLICE}`])
    expect(r).toMatchObject({ ok: true, found: { candidates: 3, verified: 3, boards: 2, listed: 20, kept: 4, stored: 2 } })
    expect(r.next).toBeUndefined()
    expect(reads).toEqual(['e0', 'e1'])
    expect(tables.company_directory).toHaveLength(3)
  })

  it('a board that could not be read is counted and does not stop the slice', async () => {
    const { ctx, deps, reads } = setup({ boards: 3, readFails: new Set(['e1']) })
    expect(await sweepWith(ctx, deps)).toMatchObject({ ok: true, found: { boards: 3, read_failed: 1 } })
    expect(reads).toHaveLength(3)
  })

  it('starts no new work after the slice deadline: a spent clock reads no board and checks no candidate past its budget', async () => {
    let t = NOW
    const { ctx, deps, reads } = setup({ candidates: 30, boards: 100, now: () => (t += 50_000), deadlineAt: NOW + 240_000 })
    const r = await sweepWith(ctx, deps)
    expect(r.ok).toBe(true)
    expect((r.found as { candidates: number }).candidates).toBeLessThan(30)
    expect(reads.length).toBeLessThan(100)
    expect(reads).toEqual([])
  })

  it('a database that does not answer is a failure the slice reports, not a crash', async () => {
    const { ctx, deps } = setup({ rpcError: 'candidates' })
    // null data is an empty list; an error object is what the client answers on a failure
    const failing = { ...ctx, admin: { rpc: async () => ({ data: null, error: { message: 'down' } }) } as never }
    expect(await sweepWith(failing, deps)).toMatchObject({ ok: false, failure: 'candidates_due_failed' })
  })
})

describe('directory.sweep: the profile fill', () => {
  const entity = (website: string, qid = 'Q1'): WikidataEntity => ({ qid, label: 'x', website, hq: 'San Francisco', employees: 75, industry: null, logo: null, founded: 2023, ticker: null, github: null, fetchedAt: '2026-10-21T00:00:00.000Z' })
  const verified = (id: string, name: string, domain: string | null, verifiedAt: string, extra: Record<string, unknown> = {}) => ({ id, name, domain, verified_at: verifiedAt, ...extra })

  it('gives the oldest verified employer without a profile Wikidata\'s facts when the website is its own domain, one employer per slice', async () => {
    const asked: string[] = []
    const { ctx, deps, tables } = setup({
      directory: [
        verified('e1', 'Retell AI', 'retellai.com', '2026-10-02T00:00:00Z'),
        verified('e0', 'Acme', 'acme.com', '2026-10-01T00:00:00Z'),
        verified('e2', 'Done Co', 'done.com', '2026-09-01T00:00:00Z', { profile: { source: 'wikidata', matched: false } }),
        { id: 'e3', name: 'Closed Co', domain: 'closed.com', verified_at: null },
      ],
      wikidata: async (name) => (asked.push(name), name === 'Acme' ? [entity('https://www.acme.com/', 'Q7')] : [entity('https://other.example/')]),
    })
    const byId = (id: string) => tables.company_directory.find((r) => r.id === id)
    expect(await sweepWith(ctx, deps)).toMatchObject({ ok: true, found: { profiled: 1 } })
    expect(asked).toEqual(['Acme'])
    expect(byId('e0')?.profile).toMatchObject({ source: 'wikidata', qid: 'Q7', website: 'https://www.acme.com/', hq: 'San Francisco', fetched_at: '2026-10-21T00:00:00.000Z' })
    expect(byId('e1')?.profile).toBeUndefined()
    // the next slice takes the next employer; a website on another domain is not the employer's, so only the marker is kept
    await sweepWith(ctx, deps)
    expect(asked).toEqual(['Acme', 'Retell AI'])
    expect(byId('e1')?.profile).toEqual({ source: 'wikidata', checked_at: new Date(NOW).toISOString(), matched: false })
    // nothing left to ask: the finished and the closed rows are left alone
    expect(await sweepWith(ctx, deps)).toMatchObject({ found: { profiled: 0 } })
    expect(asked).toHaveLength(2)
    expect(byId('e2')?.profile).toEqual({ source: 'wikidata', matched: false })
    expect(byId('e3')?.profile).toBeUndefined()
  })

  it('takes the best match for an employer with no domain, and writes nothing when Wikidata does not answer', async () => {
    const none = setup({ directory: [verified('e1', 'Domainless', null, '2026-10-01T00:00:00Z')], wikidata: async () => [entity('https://anything.example/')] })
    await sweepWith(none.ctx, none.deps)
    expect(none.tables.company_directory[0].profile).toMatchObject({ source: 'wikidata', website: 'https://anything.example/' })
    const down = setup({ directory: [verified('e1', 'Retell AI', 'retellai.com', '2026-10-01T00:00:00Z')], wikidata: async () => { throw new Error('wikidata 503') } })
    expect(await sweepWith(down.ctx, down.deps)).toMatchObject({ ok: true, found: { profiled: 0, errors: 1 } })
    expect(down.tables.company_directory[0].profile).toBeUndefined()
  })

  it('starts no Wikidata lookup past the slice deadline, and drops one that runs past it without writing', async () => {
    const row = verified('e1', 'Retell AI', 'retellai.com', '2026-10-01T00:00:00Z')
    // the clock reads inside the deadline for the sweep's own checks, then past it when the fill looks
    let reads = 0
    const late = setup({ directory: [row], now: () => NOW + (++reads > 2 ? 10_000 : 0), deadlineAt: NOW + 5_000, wikidata: vi.fn(async () => [entity('https://www.retellai.com/')]) })
    expect(await sweepWith(late.ctx, late.deps)).toMatchObject({ ok: true, found: { profiled: 0, errors: 0 } })
    expect(late.deps.wikidata).not.toHaveBeenCalled()
    expect(late.tables.company_directory[0].profile).toBeUndefined()

    const slow = setup({ directory: [row], now: () => Date.now(), deadlineAt: Date.now() + 40, wikidata: () => new Promise(() => {}) })
    expect(await sweepWith(slow.ctx, slow.deps)).toMatchObject({ ok: true, found: { profiled: 0, errors: 0 } })
    expect(slow.tables.company_directory[0].profile).toBeUndefined()
  })
})
