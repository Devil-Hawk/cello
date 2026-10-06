// loadDigestState against an in-memory fake of the tables it reads: that it asks
// for the right rows (this user's, recent, not already acted on) and shapes them
// for buildDigest. The wording and the rules are build.test.ts's job.

import { describe, expect, it } from 'vitest'
import { fakeAdmin } from '../../scripts/evals/outputs/lib/fake-admin'
import { composeDigest, loadDigestState } from './compose'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString()
const USER = 'user-1'

function role(user: string, job: { id: string; title: string; url: string | null; discovered_at: string; company_id: string }, chance: string, want_p: number, want_reason: string | null) {
  return { user_id: user, job_id: job.id, hidden_reason: null, chance, want_p, want_reason, jobs: { ...job, still_open: true } }
}

function tables() {
  return {
    companies: [
      { id: 'co-1', user_id: USER, name: 'Linear' },
      { id: 'co-2', user_id: USER, name: 'Notion' },
      { id: 'co-x', user_id: 'someone-else', name: 'Secret Inc' },
    ],
    profiles: [{ id: USER, preferences: { outreach: { followUpDays: 5 } } }],
    // The role a person is shown is their own row (their want and chance on it) with the posting embedded.
    person_roles: [
      role(USER, { id: 'j-new', title: 'Staff Engineer', url: 'https://linear.app/1', discovered_at: day(1), company_id: 'co-1' }, 'strong', 0.9, 'Maps to your ledger work.'),
      role(USER, { id: 'j-applied', title: 'Applied Role', url: null, discovered_at: day(1), company_id: 'co-1' }, 'strong', 0.95, null),
      role(USER, { id: 'j-old', title: 'Old Role', url: null, discovered_at: day(30), company_id: 'co-1' }, 'strong', 0.99, null),
      role('someone-else', { id: 'j-other', title: 'Not Yours', url: null, discovered_at: day(1), company_id: 'co-x' }, 'strong', 0.99, null),
    ],
    person_jobs: [{ id: 'j-title', viewer_id: USER, title: 'Senior Backend Engineer' }],
    applications: [
      { id: 'a1', user_id: USER, job_id: 'j-applied', stage: 'interview', updated_at: day(2), applied_at: day(20), jobs: { id: 'j-applied', title: 'Applied Role', company_id: 'co-1' } },
      { id: 'a2', user_id: 'someone-else', job_id: 'j-other', stage: 'applied', updated_at: day(30), applied_at: day(30), jobs: { id: 'j-other', title: 'Not Yours', company_id: 'co-x' } },
    ],
    application_drafts: [
      { id: 'd1', user_id: USER, status: 'pending_review' },
      { id: 'd2', user_id: USER, status: 'approved' },
    ],
    outreach_messages: [
      { id: 'o1', user_id: USER, status: 'sent', kind: 'initial', to_name: 'Jane Park', to_email: 'jane@ramp.com', company_id: 'co-1', job_id: 'j-title', parent_id: null, sent_at: day(10), replied_at: day(2), reply_classification: 'positive' },
      { id: 'o2', user_id: USER, status: 'sent', kind: 'initial', to_name: 'Sam Lee', to_email: 'sam@notion.so', company_id: 'co-2', job_id: null, parent_id: null, sent_at: day(9), replied_at: null, reply_classification: null },
      { id: 'o3', user_id: USER, status: 'sent', kind: 'initial', to_name: 'Has Followup', to_email: 'h@x.com', company_id: null, job_id: null, parent_id: null, sent_at: day(12), replied_at: null, reply_classification: null },
      { id: 'o4', user_id: USER, status: 'pending_review', kind: 'follow_up', to_name: 'Has Followup', to_email: 'h@x.com', company_id: null, job_id: null, parent_id: 'o3', sent_at: null, replied_at: null, reply_classification: null },
      { id: 'o5', user_id: USER, status: 'sent', kind: 'initial', to_name: 'Bounced', to_email: 'b@x.com', company_id: null, job_id: null, parent_id: null, sent_at: day(3), replied_at: day(3), reply_classification: 'bounce' },
      { id: 'o6', user_id: 'someone-else', status: 'pending_review', kind: 'initial', to_name: 'Other', to_email: 'o@x.com', company_id: null, job_id: null, parent_id: null, sent_at: null, replied_at: null, reply_classification: null },
    ],
  }
}

describe('loadDigestState', () => {
  it('reads only this user, and only what is recent and not already acted on', async () => {
    const state = await loadDigestState(fakeAdmin(tables()) as never, USER, NOW)

    expect(state.companyCount).toBe(2)
    expect(state.pendingOutreach).toBe(1)
    expect(state.pendingApplications).toBe(1)
    // The role the user applied to is flagged so it can be left out; the old and the other user's roles are not read.
    expect(state.roles.map((r) => [r.id, r.hasApplication])).toEqual([
      ['j-applied', true],
      ['j-new', false],
    ])
    // The want and the chance are the person's own, read from their row.
    expect(state.roles.find((r) => r.id === 'j-new')).toMatchObject({ chance: 'strong', want: 0.9, reason: 'Maps to your ledger work.' })
    expect(state.applications.map((a) => a.id)).toEqual(['a1'])
    expect(Object.keys(state.applications[0])).not.toContain('kit')
  })

  it('finds the reply, the follow-up that is allowed, and leaves out the bounce and the thread that has one', async () => {
    const state = await loadDigestState(fakeAdmin(tables()) as never, USER, NOW)
    expect(state.replies).toEqual([{ name: 'Jane Park', company: 'Linear', jobTitle: 'Senior Backend Engineer', repliedAt: day(2) }])
    expect(state.followUps.map((f) => f.name)).toEqual(['Sam Lee'])
    expect(state.sentLast30).toBe(4)
    expect(state.repliesLast30).toBe(1)
  })

  it('composes an applied-to role out of the new roles', async () => {
    const digest = await composeDigest(fakeAdmin(tables()) as never, USER)
    const roles = digest.sections.find((s) => s.id === 'new_roles')
    expect(roles?.items.map((i) => i.text).join('\n') ?? '').not.toContain('Applied Role')
  })
})
