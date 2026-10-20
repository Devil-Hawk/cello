import { describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'

// person_jobs is a view the fake admin does not hold: this stands in for it and answers the same rows to every read.
const view = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], total: 0 }))
vi.mock('@/lib/jobs/person-jobs', () => ({
  personJobs: () => {
    const q: Record<string, unknown> = {}
    let head = false
    for (const m of ['eq', 'is', 'neq', 'not', 'or', 'order']) q[m] = () => q
    q.select = (_c: string, o?: { head?: boolean }) => ((head = !!o?.head), q)
    q.limit = () => Promise.resolve({ data: view.rows, error: null })
    q.then = (res: (v: unknown) => unknown) => res(head ? { count: view.total, error: null } : { data: view.rows, error: null })
    return q
  },
}))

import { findRoles } from './find-roles'

const role = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, title, location: 'San Francisco, CA', salary_range: null, posted_at: '2026-10-01T00:00:00Z',
  role_type: 'ai-engineer', viewer_role_type: null, viewer_company_name: 'Acme', employer_id: null, ...over,
})
const prefs = (targeting: unknown, preferredLocations?: string[]) => ({ preferences: { targeting, preferredLocations } })
const base = { limit: 12 }

describe('findRoles with saved targets', () => {
  it('uses the saved targets and names them', async () => {
    view.total = 40
    view.rows = [
      role('a', 'AI Engineer'),
      role('b', 'ML Engineer', { role_type: 'ml-engineer' }),
      role('c', 'Backend Engineer', { role_type: 'backend-engineer' }),
      role('d', 'AI Engineer', { location: 'Berlin' }),
    ]
    const db = makeFakeAdmin({ profiles: [{ id: 'u1', ...prefs({ role_types: ['ai-engineer', 'ml-engineer', 'nope', 'other'] }, ['SF', 'San Francisco']) }] })
    const out = await findRoles(db, 'u1', base)
    expect(out.things.map((t) => t.id)).toEqual(['a', 'b'])
    expect(out.sentence).toBe('Searched your 40 stored roles for your targets, AI Engineer and ML Engineer, in San Francisco: 2 match.')
  })

  it('leaves out roles already applied to', async () => {
    view.total = 10
    view.rows = [role('a', 'AI Engineer'), role('b', 'AI Engineer'), role('c', 'AI Engineer'), role('d', 'AI Engineer'), role('e', 'AI Engineer')]
    const db = makeFakeAdmin({
      profiles: [{ id: 'u1', ...prefs({ role_types: ['ai-engineer'] }) }],
      applications: [
        { user_id: 'u1', job_id: 'a', state: 'needs_you' },
        { user_id: 'u1', job_id: 'c', state: 'skipped' },
        { user_id: 'u1', job_id: 'd', state: 'not_sent' },
        { user_id: 'u2', job_id: 'e', state: 'sent' },
      ],
      role_reactions: [{ user_id: 'u1', job_id: 'b', reaction: 'not_for_me' }],
    })
    const out = await findRoles(db, 'u1', base)
    expect(out.things.map((t) => t.id).sort()).toEqual(['c', 'd', 'e'])
    expect(out.sentence).toBe('Searched your 10 stored roles for your targets, AI Engineer, leaving out 2 you already applied to or turned down: 3 match.')
  })

  it('treats an application with no state as applied to', async () => {
    view.rows = [role('a', 'AI Engineer')]
    const db = makeFakeAdmin({ profiles: [{ id: 'u1', ...prefs({ role_types: ['ai-engineer'] }) }], applications: [{ user_id: 'u1', job_id: 'a', state: null }] })
    expect((await findRoles(db, 'u1', base)).things).toEqual([])
  })

  it('names only the places when no type is saved', async () => {
    view.total = 5
    const db = makeFakeAdmin({ profiles: [{ id: 'u1', ...prefs({}, ['New York', 'Remote']) }] })
    view.rows = [role('a', 'Anything', { location: 'Remote' }), role('b', 'Anything', { location: 'Berlin' })]
    const out = await findRoles(db, 'u1', base)
    expect(out.things.map((t) => t.id)).toEqual(['a'])
    expect(out.sentence).toBe('Searched your 5 stored roles in New York or Remote: 1 match.')
  })

  it('keeps an explicit search as it was', async () => {
    view.total = 40
    view.rows = [role('a', 'AI Engineer'), role('b', 'ML Engineer', { role_type: 'ml-engineer' })]
    const db = makeFakeAdmin({
      profiles: [{ id: 'u1', ...prefs({ role_types: ['backend-engineer'] }, ['Berlin']) }],
      applications: [{ user_id: 'u1', job_id: 'a', state: 'sent' }],
    })
    const out = await findRoles(db, 'u1', { ...base, place: 'SF' })
    expect(out.things.map((t) => t.id)).toEqual(['a', 'b'])
    expect(out.sentence).toBe('Searched your 40 stored roles for in San Francisco: 2 match.')
  })

  it('says where to set targets when none are saved', async () => {
    view.total = 7
    view.rows = [role('a', 'AI Engineer')]
    const db = makeFakeAdmin({ profiles: [{ id: 'u1', preferences: {} }] })
    const out = await findRoles(db, 'u1', base)
    expect(out.things).toHaveLength(1)
    expect(out.sentence).toBe('Searched your 7 stored roles: 1 match. Set the roles and places you want on Your search, and Cello uses them here.')
  })

  it('stays within 400 characters and cuts long lists', async () => {
    view.total = 9
    view.rows = []
    const places = Array.from({ length: 12 }, (_, i) => `Somewhere with a long name number ${i}`)
    const db = makeFakeAdmin({ profiles: [{ id: 'u1', ...prefs({ role_types: ['ai-engineer', 'ml-engineer', 'applied-scientist', 'research-engineer', 'research-scientist', 'data-scientist', 'data-engineer', 'analytics-engineer'] }, places) }] })
    const out = await findRoles(db, 'u1', base)
    expect(out.sentence.length).toBeLessThanOrEqual(400)
    expect(out.sentence).toContain('more')
  })

  it('throws when the profile read fails', async () => {
    const db = makeFakeAdmin({})
    ;(db as unknown as { from: unknown }).from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) })
    await expect(findRoles(db, 'u1', base)).rejects.toThrow('could not read')
  })
})
