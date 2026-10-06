// Every number and drill-down here counts the person's own open roles only: a 200-day-old posting is not one.
// The query starts at their person_roles rows, so the posting's columns are filtered through the embed.

import { describe, expect, it, vi } from 'vitest'

const calls: Array<[string, ...unknown[]]> = []

function chain(table: string): Record<string, unknown> {
  const q: Record<string, unknown> = {}
  calls.push(['from', table])
  for (const m of ['select', 'or', 'not', 'is', 'eq', 'neq', 'gte', 'lte', 'order', 'limit']) {
    q[m] = (...args: unknown[]) => {
      calls.push([m, ...args])
      return q
    }
  }
  q.range = (...args: unknown[]) => {
    calls.push(['range', ...args])
    return Promise.resolve({ data: [{ chance: 'strong', blocked_reasons: [], assessed_at: '2026-10-06T00:00:00Z', jobs: { source: 'greenhouse' } }], error: null })
  }
  q.then = (resolve: (v: unknown) => unknown) =>
    resolve({
      data: [{ chance: 'strong', blocked_reasons: [], assessed_at: '2026-10-06T00:00:00Z', want_p: 0.8, jobs: { id: 'j1', title: 'Engineer', url: null, posted_at: null, companies: { name: 'Acme', domain: null } } }],
      error: null,
      count: 1,
    })
  return q
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: (table: string) => chain(table),
  }),
}))

import { GET } from './route'

const get = (qs: string) => GET(new Request('http://x/api/jobs/insights-summary' + qs) as never)

describe('GET /api/jobs/insights-summary', () => {
  it('reads the person\'s own rows and never the jobs table directly', async () => {
    calls.length = 0
    await get('')
    expect(calls.filter(([m]) => m === 'from')).toEqual([['from', 'person_roles']])
  })

  it('limits the aggregate to roles inside the 180-day window that are not closed', async () => {
    calls.length = 0
    await get('')
    expect(calls.some(([m, f, o]) => m === 'or' && String(f).startsWith('posted_at.gte.') && String(f).endsWith('posted_at.is.null') && (o as { referencedTable?: string }).referencedTable === 'jobs')).toBe(true)
    expect(calls).toContainEqual(['not', 'jobs.still_open', 'is', false])
  })

  it('limits a chance-band drill-down the same way, and returns the verdict columns beside the role', async () => {
    calls.length = 0
    const res = await get('?band=strong')
    expect(calls.some(([m, f]) => m === 'or' && String(f).startsWith('posted_at.gte.'))).toBe(true)
    expect(calls).toContainEqual(['not', 'jobs.still_open', 'is', false])
    expect(calls).toContainEqual(['eq', 'chance', 'strong'])
    const body = await res.json()
    expect(body.jobs[0]).toMatchObject({ id: 'j1', title: 'Engineer', chance: 'strong', assessed_at: '2026-10-06T00:00:00Z', company: { name: 'Acme' } })
    expect(Object.keys(body.jobs[0])).not.toContain('fit_assessed_at')
  })

  it('finds the roles not yet assessed by the person\'s own check date', async () => {
    calls.length = 0
    await get('?band=unassessed')
    expect(calls).toContainEqual(['is', 'assessed_at', null])
  })
})
