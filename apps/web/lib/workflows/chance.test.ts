import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import type { AdminClient } from '@/lib/harness/types'

const assess = vi.hoisted(() => ({ assessJobs: vi.fn() }))
vi.mock('@/lib/scoring', () => ({ assessJobs: assess.assessJobs }))
const fit = vi.hoisted(() => ({ readRoleFit: vi.fn() }))
vi.mock('@/lib/fit', () => ({ readRoleFit: fit.readRoleFit }))

import { CHANCE_BATCH, checkChance, rolesGaps } from './chance'

const ctx = { admin: {} as AdminClient, userId: 'u1', llm: vi.fn() as never }
const ids = (n: number) => Array.from({ length: n }, (_, i) => `job-${i + 1}`)

beforeEach(() => {
  assess.assessJobs.mockReset().mockImplementation(async (a: { jobIds: string[] }) => ({
    assessed: a.jobIds.length,
    blocked: 0,
    failed: 0,
    remaining: 3,
    fits: new Map(a.jobIds.map((id) => [id, { jobId: id }])),
  }))
})

describe('checkChance', () => {
  it('reads the chance in batches of twelve: 25 roles make three batches', async () => {
    const out = await checkChance(ctx, ids(25))
    expect(CHANCE_BATCH).toBe(12)
    expect(assess.assessJobs.mock.calls.map((c) => c[0].jobIds.length)).toEqual([12, 12, 1])
    expect(assess.assessJobs.mock.calls.map((c) => c[0].limit)).toEqual([12, 12, 1])
    expect(out).toMatchObject({ batches: 3, assessed: 25, blocked: 0, failed: 0 })
    expect(out.fits.size).toBe(25)
  })

  it('a role named twice is checked once, and no ids make no call', async () => {
    await checkChance(ctx, ['a', 'a', 'b'])
    expect(assess.assessJobs.mock.calls[0][0].jobIds).toEqual(['a', 'b'])
    assess.assessJobs.mockClear()
    expect((await checkChance(ctx, [])).batches).toBe(0)
    expect(assess.assessJobs).not.toHaveBeenCalled()
  })

  it('a reason that stops one batch stops the rest and is reported', async () => {
    assess.assessJobs.mockResolvedValue({ assessed: 0, blocked: 0, failed: 0, remaining: 0, skippedReason: 'no-llm-key', fits: new Map() })
    const out = await checkChance(ctx, ids(30))
    expect(assess.assessJobs).toHaveBeenCalledTimes(1)
    expect(out.skippedReason).toBe('no-llm-key')
  })
})

describe('rolesGaps', () => {
  const role = (id: number, chance: string | null) => ({ user_id: 'u1', job_id: `job-${id}`, chance })
  const missing = (...texts: string[]) => ({ items: texts.map((requirement) => ({ requirement, requirementId: requirement, verdict: 'unknown', evidence: [], origin: 'code', notFound: true })) })
  const fits: Record<string, { items: unknown[] }> = {}
  beforeEach(() => {
    for (const k of Object.keys(fits)) delete fits[k]
    fit.readRoleFit.mockReset().mockImplementation(async (_deps: unknown, id: string) => fits[id] ?? { items: [] })
  })

  it('counts, in code, how many Stretch roles share a requirement nothing in the person\'s material answers', async () => {
    // Nine checked roles: seven Stretch, five of them missing Kubernetes, two Go.
    for (const i of [1, 2, 3, 4, 5]) fits[`job-${i}`] = missing('Kubernetes', ...(i <= 2 ? ['Go'] : []))
    fits['job-6'] = missing('Rust')
    const rows = [...[1, 2, 3, 4, 5, 6, 7].map((i) => role(i, 'stretch')), role(8, 'possible'), role(9, 'strong'), role(10, null)]
    const admin = makeFakeAdmin({ person_roles: rows }) as unknown as AdminClient
    const out = await rolesGaps(admin, 'u1', ids(10))
    expect(out).toMatchObject({ assessed: 9, stretch: 7, tooFew: false })
    expect(out.gaps).toEqual([
      { requirement: 'Kubernetes', roles: 5 },
      { requirement: 'Go', roles: 2 },
    ])
    expect(out.line).toBe('5 of 7 Stretch roles ask for Kubernetes, which is not in your resume, answers or material.')
  })

  it('counts only Not found items: a model\'s gap, a person\'s call and a negated mention are not counted', async () => {
    const notFound = missing('Kubernetes').items[0]
    for (const i of [1, 2, 3, 4, 5]) {
      fits[`job-${i}`] = {
        items: [
          notFound,
          { ...notFound, requirement: 'Rust', origin: 'model', verdict: 'gap', notFound: undefined },
          { ...notFound, requirement: 'Java', origin: 'person', verdict: 'gap', notFound: undefined },
          { ...notFound, requirement: 'Terraform', notFound: undefined },
        ],
      }
    }
    const admin = makeFakeAdmin({ person_roles: [1, 2, 3, 4, 5].map((i) => role(i, 'stretch')) }) as unknown as AdminClient
    expect((await rolesGaps(admin, 'u1', ids(5))).gaps).toEqual([{ requirement: 'Kubernetes', roles: 5 }])
  })

  it('says too few to tell under five checked roles, reads no fit and names no gap', async () => {
    const admin = makeFakeAdmin({ person_roles: [role(1, 'stretch'), role(2, 'stretch'), role(3, 'possible')] }) as unknown as AdminClient
    const out = await rolesGaps(admin, 'u1', ids(3))
    expect(out).toMatchObject({ tooFew: true, gaps: [], assessed: 3 })
    expect(out.line).toMatch(/Too few to tell/)
    expect(fit.readRoleFit).not.toHaveBeenCalled()
  })

  it('reads only this person\'s roles', async () => {
    for (const i of [1, 2, 3, 4, 5]) fits[`job-${i}`] = missing('Kubernetes')
    const mine = [1, 2, 3, 4, 5].map((i) => role(i, 'stretch'))
    const theirs = [1, 2, 3, 4, 5].map((i) => ({ ...role(i, 'stretch'), user_id: 'u2' }))
    const admin = makeFakeAdmin({ person_roles: [...mine, ...theirs] }) as unknown as AdminClient
    await rolesGaps(admin, 'u1', ids(5))
    expect(fit.readRoleFit).toHaveBeenCalledTimes(5)
    expect(fit.readRoleFit.mock.calls.every((c) => c[0].userId === 'u1')).toBe(true)
  })

  it('says so when no checked role is a Stretch', async () => {
    const admin = makeFakeAdmin({ person_roles: [1, 2, 3, 4, 5].map((i) => role(i, 'strong')) }) as unknown as AdminClient
    expect((await rolesGaps(admin, 'u1', ids(5))).line).toBe('None of your 5 checked roles is a Stretch.')
  })
})
