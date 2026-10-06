import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/insights/store', () => ({ readStandingPreferences: async () => 'WHAT THIS USER HAS TOLD YOU THEY WANT:\n- Prefers small teams' }))

import { profileCard } from './profile-card'
import { makeFakeAdmin } from './testing/fake-admin'

describe('profileCard', () => {
  it('is a short card from the persons own record: facts, rules, and what they told Cello', async () => {
    const admin = makeFakeAdmin({
      profiles: [{ id: 'u1', full_name: 'Dana Lee', resume_text: 'Dana Lee\nSenior engineer at Acme\n' + 'word '.repeat(400), preferences: { preferredLocations: ['Seattle'], targeting: { excludedCompanies: ['badco'], seniority: ['senior'] } } }],
      applications: [{ user_id: 'u1', stage: 'applied' }, { user_id: 'u1', stage: 'applied' }, { user_id: 'u1', stage: 'interview' }, { user_id: 'u2', stage: 'offer' }],
    })
    const card = await profileCard(admin, 'u1', new Date('2026-10-05T12:00:00Z'))
    expect(card).toContain('Name: Dana Lee')
    expect(card).toMatch(/Resume on file: \d+ words\. Starts: Dana Lee \| Senior engineer at Acme/)
    expect(card).toContain('Places: Seattle')
    expect(card).toContain('Rules out (companies): badco')
    expect(card).toContain('Applications: 2 applied, 1 interview')
    expect(card).toContain('Today: 2026-10-05')
    expect(card).toContain('Prefers small teams')
    expect(card.length).toBeLessThan(1500)
  })

  it('no resume tells the model to ask for one before writing anything', async () => {
    const admin = makeFakeAdmin({ profiles: [{ id: 'u1', full_name: null, resume_text: '', preferences: {} }] })
    const card = await profileCard(admin, 'u1')
    expect(card).toContain('Resume on file: none')
    expect(card).toContain('Applications: none yet.')
  })

  it('never contains the resume text itself beyond a short headline', async () => {
    const admin = makeFakeAdmin({ profiles: [{ id: 'u1', resume_text: 'Dana Lee\nEngineer\nSECRET DETAIL ON LINE THREE', preferences: {} }] })
    expect(await profileCard(admin, 'u1')).not.toContain('SECRET DETAIL')
  })
})
