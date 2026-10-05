// Every number and drill-down here counts open roles only: a 200-day-old posting is not one.

import { describe, expect, it, vi } from 'vitest'

const calls: Array<[string, ...unknown[]]> = []

function chain(): Record<string, unknown> {
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'or', 'not', 'is', 'gte', 'lte', 'order', 'limit']) {
    q[m] = (...args: unknown[]) => {
      calls.push([m, ...args])
      return q
    }
  }
  q.range = (...args: unknown[]) => {
    calls.push(['range', ...args])
    return Promise.resolve({ data: [{ source: 'greenhouse', match_score: 80 }], error: null })
  }
  q.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 })
  return q
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => chain(),
  }),
}))

import { GET } from './route'

const get = (qs: string) => GET(new Request(`http://x/api/jobs/insights-summary${qs}`) as never)

describe('GET /api/jobs/insights-summary', () => {
  it('limits the aggregate to roles inside the 180-day window that are not closed', async () => {
    calls.length = 0
    await get('')
    expect(calls.some(([m, f]) => m === 'or' && String(f).startsWith('posted_at.gte.') && String(f).endsWith('posted_at.is.null'))).toBe(true)
    expect(calls).toContainEqual(['not', 'still_open', 'is', false])
  })

  it('limits a score-band drill-down the same way', async () => {
    calls.length = 0
    await get('?band=strong')
    expect(calls.some(([m, f]) => m === 'or' && String(f).startsWith('posted_at.gte.'))).toBe(true)
    expect(calls).toContainEqual(['not', 'still_open', 'is', false])
  })
})
