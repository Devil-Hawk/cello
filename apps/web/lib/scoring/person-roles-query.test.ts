import { describe, expect, it } from 'vitest'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { EMPTY_TARGETING } from '@/lib/targeting'
import { applyRoleTargets } from '@/lib/targeting/roles'
import { OnJobs } from './person-roles-query'

/** Records every filter call, as the PostgREST builder would receive it. */
function recorder() {
  const calls: [string, ...unknown[]][] = []
  const q: Record<string, (...a: unknown[]) => unknown> = {}
  for (const m of ['eq', 'in', 'gte', 'ilike', 'is', 'not', 'or']) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, ...a])
      return q
    }
  }
  return { q, calls }
}

describe('OnJobs', () => {
  it('puts the embed in front of every posting column', () => {
    const { q, calls } = recorder()
    new OnJobs(q).eq('company_id', 'c1').in('country', ['US']).gte('posted_at', 'x').ilike('location', '%a%').is('quality_score', null).not('title', 'ilike', '%x%')
    expect(calls).toEqual([
      ['eq', 'jobs.company_id', 'c1'],
      ['in', 'jobs.country', ['US']],
      ['gte', 'jobs.posted_at', 'x'],
      ['ilike', 'jobs.location', '%a%'],
      ['is', 'jobs.quality_score', null],
      ['not', 'jobs.title', 'ilike', '%x%'],
    ])
  })

  it('sends an or filter into the embed, so its column names mean the posting\'s', () => {
    const { q, calls } = recorder()
    new OnJobs(q).or('posted_at.is.null,posted_at.gte.2026-01-01')
    expect(calls).toEqual([['or', 'posted_at.is.null,posted_at.gte.2026-01-01', { referencedTable: 'jobs' }]])
  })

  it('lets the open roles rule and the target filters run unchanged on a person_roles query', () => {
    const { q, calls } = recorder()
    const on = new OnJobs(q)
    openRolesOnly(on)
    applyRoleTargets(on, { ...EMPTY_TARGETING, functions: ['engineering'], remoteOnly: true })
    expect(calls.every(([m, a, b]) => (m === 'or' ? (b as { referencedTable?: string }).referencedTable === 'jobs' : String(a).startsWith('jobs.')))).toBe(true)
    expect(calls.some(([m, col]) => m === 'not' && col === 'jobs.still_open')).toBe(true)
    expect(calls.some(([m, col]) => m === 'in' && col === 'jobs.job_function')).toBe(true)
    expect(calls.some(([m, col]) => m === 'eq' && col === 'jobs.is_remote')).toBe(true)
  })

  it('keeps the query it wraps', () => {
    const { q } = recorder()
    expect(new OnJobs(q).eq('id', '1').query).toBe(q)
  })
})
