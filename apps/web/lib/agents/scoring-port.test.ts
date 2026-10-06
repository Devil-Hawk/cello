import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoleFit } from '@/lib/scoring/types'

const mocks = vi.hoisted(() => ({ assessJobs: vi.fn() }))
vi.mock('@/lib/scoring', async (orig) => ({ ...(await orig<typeof import('@/lib/scoring')>()), assessJobs: mocks.assessJobs }))

import { NOT_ASSESSED, recordReaction, roleView, shortlistFor } from './scoring-port'
import { makeFakeAdmin, type FakeAdmin } from './testing/fake-admin'

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

/** One person_roles row: the person's own verdict on a role, with the posting embedded. */
const role = (id: string, over: Record<string, unknown> = {}, posting: Record<string, unknown> = {}) => ({
  user_id: 'u1',
  job_id: id,
  hidden_reason: null,
  assessed_at: null,
  blocked_reasons: [],
  want_p: null,
  want_reason: null,
  want_detail: null,
  chance: null,
  chance_detail: null,
  jobs: {
    id,
    title: `Role ${id}`,
    company_id: `c-${id}`,
    location: 'Seattle, WA',
    posted_at: daysAgo(Number(id.replace(/\D/g, '')) || 1),
    url: `https://x.test/${id}`,
    description: 'Build things.',
    is_new: true,
    still_open: true,
    salary_range: null,
    companies: { user_id: 'u1', name: `Company ${id}`, is_dream_company: false },
    ...posting,
  },
  ...over,
})

/** An assessed role: a chance with one met requirement and one gap, and how much the person wants it. */
const assessed = (id: string, chance: string, want: number, over: Record<string, unknown> = {}, posting: Record<string, unknown> = {}) =>
  role(
    id,
    {
      assessed_at: daysAgo(0),
      chance,
      want_p: want,
      chance_detail: { checks: [{ requirement: 'Python', mustHave: true, status: 'met', evidence: { line: 2, quote: 'Used Python at scale' } }], gaps: ['No Go'] },
      ...over,
    },
    posting
  )

function setup(rows: Record<string, unknown>[]): FakeAdmin {
  return makeFakeAdmin({ person_roles: rows, role_reactions: [], applications: [] })
}

const base = { userId: 'u1', apiKeys: { openrouter: 'k', userId: 'u1' } }

beforeEach(() => mocks.assessJobs.mockReset())

describe('shortlistFor', () => {
  it('ranks by chance then want, gives each assessed role its reason, and never guesses for an unassessed one', async () => {
    const admin = setup([
      assessed('j1', 'possible', 0.5),
      assessed('j2', 'strong', 0.4, { want_reason: 'Built billing at Acme' }),
      role('j3'),
      assessed('j4', 'cannot_assess', 0.9),
    ])
    const out = await shortlistFor({ ...base, admin, limit: 5 })
    expect(out.picks.map((p) => p.jobId)).toEqual(['j2', 'j1', 'j4', 'j3'])
    expect(out.picks[0]).toMatchObject({ chance: 'strong', reason: 'Built billing at Acme', company: 'Company j2' })
    expect(out.picks[1]).toMatchObject({ chance: 'possible', reason: 'Python: Used Python at scale', gaps: ['No Go'] })
    expect(out.picks[2]).toMatchObject({ chance: null, reason: NOT_ASSESSED })
    expect(out.picks[3]).toMatchObject({ chance: null, reason: NOT_ASSESSED })
  })

  it('leaves out roles the person hid, old roles, closed roles and roles that are not new', async () => {
    const admin = setup([
      assessed('j1', 'strong', 0.9),
      assessed('j2', 'strong', 0.9, { hidden_reason: 'not_for_me' }),
      assessed('j3', 'strong', 0.9, {}, { is_new: false }),
      assessed('j4', 'strong', 0.9, {}, { posted_at: daysAgo(400) }),
      assessed('j5', 'strong', 0.9, {}, { still_open: false }),
    ])
    expect((await shortlistFor({ ...base, admin, limit: 5 })).picks.map((p) => p.jobId)).toEqual(['j1'])
  })

  it('applies the stated filters', async () => {
    const admin = setup([
      assessed('j1', 'strong', 0.9, {}, { location: 'Austin, TX' }),
      assessed('j2', 'strong', 0.8),
      assessed('j3', 'strong', 0.7, {}, { location: 'Remote', companies: { user_id: 'u1', name: 'Dream Co', is_dream_company: true } }),
    ])
    expect((await shortlistFor({ ...base, admin, limit: 5, location: 'seattle' })).picks.map((p) => p.jobId)).toEqual(['j2'])
    expect((await shortlistFor({ ...base, admin, limit: 5, remoteOnly: true })).picks.map((p) => p.jobId)).toEqual(['j3'])
    expect((await shortlistFor({ ...base, admin, limit: 5, dreamOnly: true })).picks.map((p) => p.jobId)).toEqual(['j3'])
  })

  it("never shows another person's roles", async () => {
    const admin = setup([assessed('j1', 'strong', 0.9, { user_id: 'someone-else' })])
    expect((await shortlistFor({ ...base, admin, limit: 5 })).picks).toEqual([])
  })

  it("keeps a role stored under another follower's company, without that company", async () => {
    const admin = setup([assessed('j2', 'strong', 0.9, {}, { companies: { user_id: 'someone-else', name: 'X', is_dream_company: false } })])
    const [pick] = (await shortlistFor({ ...base, admin, limit: 5 })).picks
    expect(pick).toMatchObject({ jobId: 'j2', company: null, companyId: null })
  })

  it('labels one slot exploration: the best role below the cut, at a company not already shown', async () => {
    const admin = setup(Array.from({ length: 8 }, (_, i) => assessed(`j${i + 1}`, 'strong', 0.95 - i * 0.05)))
    const out = await shortlistFor({ ...base, admin, limit: 4 })
    expect(out.picks).toHaveLength(4)
    expect(out.picks.filter((p) => p.exploration)).toHaveLength(1)
    const explore = out.picks.at(-1)!
    expect(explore.exploration).toBe(true)
    // The first three are the top three; the exploration role is the next one down (j4 is the cut).
    expect(out.picks.slice(0, 3).map((p) => p.jobId)).toEqual(['j1', 'j2', 'j3'])
    expect(explore.jobId).toBe('j5')
  })

  it('a short list has no exploration slot', async () => {
    const admin = setup([assessed('j1', 'strong', 0.9), assessed('j2', 'possible', 0.8)])
    expect((await shortlistFor({ ...base, admin, limit: 5 })).picks.every((p) => !p.exploration)).toBe(true)
  })

  it('assesses missing roles only when asked, and ranks what it assessed', async () => {
    const admin = setup([role('j1'), assessed('j2', 'possible', 0.5)])
    const fit: RoleFit = {
      jobId: 'j1',
      assessedAt: daysAgo(0),
      blocked: [],
      want: { p: 0.9, reason: 'Built billing at Acme', tier: 'high', calibrated: false, nReactions: 0 },
      chance: { label: 'strong', checks: [], gaps: [], confirm: [], note: null },
    }
    mocks.assessJobs.mockResolvedValue({ assessed: 1, blocked: 0, failed: 0, remaining: 0, fits: new Map([['j1', fit]]) })
    const out = await shortlistFor({ ...base, admin, limit: 5, assessMissing: 3 })
    expect(mocks.assessJobs).toHaveBeenCalledTimes(1)
    expect(mocks.assessJobs.mock.calls[0][0]).toMatchObject({ userId: 'u1', jobIds: ['j1'] })
    expect(out.assessedNow).toBe(1)
    expect(out.picks[0]).toMatchObject({ jobId: 'j1', chance: 'strong', reason: 'Built billing at Acme' })

    mocks.assessJobs.mockClear()
    await shortlistFor({ ...base, admin, limit: 5 })
    expect(mocks.assessJobs).not.toHaveBeenCalled()
  })

  it('without a key it reads what is stored and says why nothing was assessed', async () => {
    const admin = setup([role('j1')])
    const out = await shortlistFor({ ...base, apiKeys: {}, admin, limit: 5, assessMissing: 3 })
    expect(out.skippedReason).toBe('no-llm-key')
    expect(mocks.assessJobs).not.toHaveBeenCalled()
    expect(out.picks[0].reason).toBe(NOT_ASSESSED)
  })
})

describe('recordReaction', () => {
  it('Not for me hides the role for this person and keeps a reason Cello knows', async () => {
    const admin = setup([assessed('j1', 'strong', 0.8)])
    const r = await recordReaction({ admin, userId: 'u1', jobId: 'j1', reaction: 'not_for_me', reason: 'pay' })
    expect(r).toMatchObject({ ok: true, outcome: { reaction: 'not_for_me' } })
    expect(admin.tables.person_roles[0].hidden_reason).toBe('not_for_me')
    expect(admin.tables.role_reactions[0]).toMatchObject({ reaction: 'not_for_me', reason: 'pay', note: null, surface: 'chat' })
  })

  it('any other words are kept as a note, not as a reason', async () => {
    const admin = setup([assessed('j1', 'strong', 0.8)])
    await recordReaction({ admin, userId: 'u1', jobId: 'j1', reaction: 'not_for_me', reason: 'Too big a company' })
    expect(admin.tables.role_reactions[0]).toMatchObject({ reason: null, note: 'Too big a company' })
  })

  it('Interested adds a discovered application once, and Applied moves it forward', async () => {
    const admin = setup([role('j1')])
    const first = await recordReaction({ admin, userId: 'u1', jobId: 'j1', reaction: 'interested' })
    const again = await recordReaction({ admin, userId: 'u1', jobId: 'j1', reaction: 'interested' })
    expect(admin.tables.applications).toHaveLength(1)
    expect(admin.tables.applications[0]).toMatchObject({ stage: 'discovered', source: 'triage' })
    expect(first.ok && again.ok).toBe(true)
    await recordReaction({ admin, userId: 'u1', jobId: 'j1', reaction: 'applied' })
    expect(admin.tables.applications[0].stage).toBe('applied')
    // Interested never pulls an applied role back.
    await recordReaction({ admin, userId: 'u1', jobId: 'j1', reaction: 'interested' })
    expect(admin.tables.applications[0].stage).toBe('applied')
  })

  it('refuses a role that is not the persons and says how to get a real id', async () => {
    const admin = setup([role('j1', { user_id: 'other' })])
    const r = await recordReaction({ admin, userId: 'u1', jobId: 'j1', reaction: 'interested' })
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.fix).toMatch(/find_roles/)
    expect(admin.tables.applications).toHaveLength(0)
  })
})

describe('roleView', () => {
  it('shows facts and the stored assessment, and never the posting text', async () => {
    const admin = setup([assessed('j1', 'strong', 0.75, {}, { salary_range: '$150k to $180k', description: 'SECRET POSTING TEXT' })])
    const view = await roleView(admin, 'u1', 'j1')
    expect(view).toMatchObject({ chance: 'strong', salary: '$150k to $180k', assessed: true })
    expect(view?.requirements).toEqual({ covered: ['Python: Used Python at scale'], missing: ['No Go'] })
    expect(JSON.stringify(view)).not.toContain('SECRET POSTING TEXT')
    expect(await roleView(admin, 'other-user', 'j1')).toBeNull()
  })
})
