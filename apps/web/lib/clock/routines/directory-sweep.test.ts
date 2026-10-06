import { describe, expect, it } from 'vitest'
import { fakeDb } from '../../companies/fake-db'
import type { RoutineContext, RoutineRow } from '../routines'
import { BOARDS_PER_SLICE, CANDIDATES_PER_SLICE, sweepWith, type SweepDeps } from './directory-sweep'

const NOW = Date.now()
const row: RoutineRow = { id: 'r1', user_id: null, command: 'directory.sweep', args: {}, local_time: null, every: '00:30:00', timezone: 'UTC', next_due_at: null, enabled: true, slice: null }
const job = (daysAgo: number, i = 0) => ({ title: `Engineer ${i}`, url: `https://boards.example/${i}`, externalId: `${i}`, postedAt: new Date(NOW - daysAgo * 86_400_000).toISOString() })

const candidate = (i: number) => ({ id: `c${i}`, name: `Gusto ${i}`, domain: null, ats_provider: 'greenhouse', ats_token: `gusto-${i}`, source: 'kalil', failed_reads: 0, state: 'pending' })
const board = (i: number) => ({ id: `e${i}`, name: `Acme ${i}`, ats_provider: 'greenhouse', ats_token: `acme-${i}` })

function setup(o: { candidates?: number; boards?: number; now?: () => number; deadlineAt?: number; readFails?: Set<string>; rpcError?: string } = {}) {
  const calls: string[] = []
  const reads: string[] = []
  const rpc: Record<string, (a: Record<string, unknown>) => unknown> = {
    directory_candidates_due: (a) => (calls.push(`candidates:${a.p_limit}`), o.rpcError === 'candidates' ? null : Array.from({ length: o.candidates ?? 0 }, (_, i) => candidate(i))),
    directory_boards_due: (a) => (calls.push(`boards:${a.p_limit}`), Array.from({ length: o.boards ?? 0 }, (_, i) => board(i))),
  }
  const { client, tables } = fakeDb({ directory_candidates: Array.from({ length: o.candidates ?? 0 }, (_, i) => candidate(i)) }, { rpc })
  const deps: SweepDeps = {
    verify: { now: () => NOW, fetchBoard: async () => [job(2, 1)], identify: async (_p, t) => ({ name: `Gusto ${t.split('-')[1]}`, homeUrls: [] }), pageBoards: async () => [] },
    people: async () => [],
    read: async (_db, employer) => {
      reads.push(employer.id)
      if (o.readFails?.has(employer.id)) return { listed: 0, kept: 0, stored: 0, failure: 'cannot_read', errors: [] }
      return { listed: 10, kept: 2, stored: 1, errors: [] }
    },
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
