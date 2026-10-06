import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { readCard } from './cards'

const posting = (over: Record<string, unknown> = {}) => ({
  id: 'j1',
  title: 'Staff Engineer',
  company_id: 'c1',
  location: 'Seattle, WA',
  posted_at: new Date().toISOString(),
  url: 'https://ramp.test/j1',
  description: 'Build payments.',
  is_new: true,
  still_open: true,
  salary_range: '$150,000 to $180,000',
  companies: { user_id: 'u1', name: 'Ramp', is_dream_company: false },
  ...over,
})
const personRole = (over: Record<string, unknown> = {}, job: Record<string, unknown> = {}) => ({
  user_id: 'u1',
  job_id: 'j1',
  hidden_reason: null,
  assessed_at: '2026-10-05T00:00:00Z',
  blocked_reasons: [],
  want_p: 0.8,
  want_reason: 'Payments work',
  want_detail: null,
  chance: 'strong',
  chance_detail: { checks: [{ requirement: 'Python', mustHave: true, status: 'met', evidence: { line: 2, quote: 'Used Python at scale' } }], gaps: ['No Go'] },
  jobs: posting(job),
  ...over,
})
const seed = (job: Record<string, unknown> = {}) =>
  makeFakeAdmin({
    person_roles: [personRole({}, job)],
    companies: [{ id: 'c1', user_id: 'u1', name: 'Ramp', logo_url: 'https://ramp.test/logo.png', domain: 'ramp.test', watching: true }],
    applications: [{ id: 'a1', user_id: 'u1', job_id: 'j1', stage: 'applied', jobs: { company_id: 'c1' } }],
    person_jobs: [
      { id: 'j1', viewer_id: 'u1', viewer_company_id: 'c1', still_open: true },
      { id: 'j2', viewer_id: 'u1', viewer_company_id: 'c1', still_open: true },
      { id: 'j3', viewer_id: 'u1', viewer_company_id: 'c1', still_open: false },
    ],
  })

describe('readCard', () => {
  it('builds a role card from the stored rows only', async () => {
    const card = await readCard(seed(), 'u1', { kind: 'role', ref: 'j1' })
    expect(card).toEqual({
      kind: 'role',
      id: 'j1',
      title: 'Staff Engineer',
      company: 'Ramp',
      companyId: 'c1',
      logoUrl: 'https://ramp.test/logo.png',
      place: 'Seattle, WA',
      chance: 'strong',
      pay: '$150,000 to $180,000',
      state: 'applied',
    })
  })

  it('shows no pay when the posting states none, whatever a model wrote', async () => {
    const card = await readCard(seed({ salary_range: null }), 'u1', { kind: 'role', ref: 'j1' })
    expect(card).toMatchObject({ kind: 'role', pay: null })
  })

  it('gives no card for a role the person cannot read, or for anything but a role or a company', async () => {
    expect(await readCard(seed(), 'u2', { kind: 'role', ref: 'j1' })).toBeNull()
    expect(await readCard(seed(), 'u1', { kind: 'role', ref: 'missing' })).toBeNull()
    expect(await readCard(seed(), 'u1', { kind: 'person', ref: 'p1' })).toBeNull()
  })

  it('builds a company card with its counts and following state', async () => {
    const card = await readCard(seed(), 'u1', { kind: 'company', ref: 'c1' })
    expect(card).toEqual({ kind: 'company', id: 'c1', name: 'Ramp', logoUrl: 'https://ramp.test/logo.png', domain: 'ramp.test', openCount: 2, keptCount: 1, following: true })
    expect(await readCard(seed(), 'u2', { kind: 'company', ref: 'c1' })).toBeNull()
  })
})
