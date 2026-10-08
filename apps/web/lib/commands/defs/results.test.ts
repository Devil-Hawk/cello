// What is working: results.get hides what the person said was not right and marks what they kept; Keep and Not right
// each write one learning of the person's own and nothing else; a key the record no longer shows is refused (T33).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../define'
import type { StrategyReport } from '@/lib/strategy/types'

const bucket = (label: string, applications: number, replies: number) => ({ label, applications, replies, interviews: 0, replyRate: replies / applications, interviewRate: null, thinBucket: false })
const answered = (question: string, buckets: ReturnType<typeof bucket>[]) => ({ status: 'answered' as const, question, sampleSize: 21, minRequired: 15, data: { totalApplications: 21, totalWithKnownSource: 21, buckets }, summary: '', caveats: [] })
const short = (question: string) => ({ status: 'insufficient_data' as const, question, sampleSize: 3, minRequired: 15, message: `${question} needs more` })

const report = {
  sourceFunnel: answered('sourceFunnel', [bucket('Referral', 9, 5), bucket('Job board', 12, 1)]),
  chanceAccuracy: short('chanceAccuracy'),
  resumeVariants: short('resumeVariants'),
  outreachImpact: short('outreachImpact'),
  rejectionPatterns: short('rejectionPatterns'),
  applicationTiming: short('applicationTiming'),
  proposals: [],
} as unknown as StrategyReport

const loaded = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/lib/strategy/load', () => ({ loadResults: vi.fn(async () => loaded.value) }))
const store = vi.hoisted(() => ({ setLearningStatus: vi.fn(async () => undefined) }))
vi.mock('@/lib/learning/store', () => store)
const mem = vi.hoisted(() => ({ add: vi.fn(async () => ({ id: 'm1' })) }))
vi.mock('@/lib/memory/mem0-store', () => ({ getMemoryStore: () => mem }))
vi.mock('@/lib/harness/keys', () => ({ readProfileForDemoGuards: async () => ({ row: { is_demo: false, demo_expires_at: null }, error: null }) }))
vi.mock('@/lib/measures/owner', () => ({ isOwner: () => false }))

import { proposalsConfirm, proposalsDismiss, resultsGet } from './people'
import { DemoMemoryWriteRefusedError } from '@/lib/memory/types'

const rpc = vi.fn(async () => ({ error: null }))
const ctx = { userId: 'u1', admin: () => ({ rpc }), supabase: {} } as unknown as CommandContext
const REFERRAL = 'outcome:sourceFunnel:referral'

beforeEach(() => {
  vi.clearAllMocks()
  loaded.value = { report, shape: { working: [], notWorking: [], thresholds: [] }, learnings: [], kept: [], followed: { employers: new Set(), companies: new Set() } }
})

describe('results.get', () => {
  it('shows the findings with their counts, and says where a Keep would act', async () => {
    const r = (await resultsGet.run(ctx, {})) as { working: { key: string; state: string; line: string; change: string; acts: string }[]; notWorking: { key: string }[] }
    expect(r.working).toHaveLength(1)
    expect(r.working[0]).toMatchObject({ key: REFERRAL, state: 'new', line: '5 of 9 applications from Referral got a reply.', change: 'Show roles from Referral first', acts: 'Which roles come first in Roles.' })
    expect(r.notWorking).toHaveLength(1)
  })

  it('marks a kept finding, and hides one the person said was not right', async () => {
    loaded.value = { ...(loaded.value as object), learnings: [{ key: `kept:${REFERRAL}`, status: 'active' }, { key: 'kept:outcome:sourceFunnel:job-board', status: 'off' }] }
    const r = (await resultsGet.run(ctx, {})) as { working: { state: string }[]; notWorking: unknown[] }
    expect(r.working[0].state).toBe('kept')
    expect(r.notWorking).toHaveLength(0)
  })
})

describe('Keep and Not right', () => {
  it('Keep writes one learning of the person\'s own, with the effect and the counted group, and touches nothing else', async () => {
    const out = await proposalsConfirm.run(ctx, { key: REFERRAL })
    expect(out).toMatchObject({ key: REFERRAL, kept: 'Show roles from Referral first', acts: 'Which roles come first in Roles.' })
    expect(mem.add).toHaveBeenCalledTimes(1)
    const [user, input] = mem.add.mock.calls[0] as unknown as [string, { fact: string; scope: string; refs: Record<string, unknown> }]
    expect(user).toBe('u1')
    expect(input.fact).toBe('Show roles from Referral first')
    expect(input.refs).toMatchObject({ key: `kept:${REFERRAL}`, effect: 'rank.fresh', status: 'active', origin: 'person', params: { group: 'Referral', replies: 5, applications: 9 } })
    expect(store.setLearningStatus).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled() // no rule, setting or other store is written
  })

  it('Keep on a choice that already exists only changes its status', async () => {
    loaded.value = { ...(loaded.value as object), learnings: [{ id: 'l9', key: `kept:${REFERRAL}`, status: 'off' }] }
    await proposalsConfirm.run(ctx, { key: REFERRAL })
    expect(store.setLearningStatus).toHaveBeenCalledWith('u1', 'l9', 'active')
    expect(mem.add).not.toHaveBeenCalled()
  })

  it('Not right stores the choice off, so the finding is hidden and nothing acts on it', async () => {
    await proposalsDismiss.run(ctx, { key: REFERRAL })
    const [, input] = mem.add.mock.calls[0] as unknown as [string, { fact: string; refs: Record<string, unknown> }]
    expect(input.refs).toMatchObject({ key: `kept:${REFERRAL}`, status: 'off' })
    expect(input.fact).toBe('Not right: 5 of 9 applications from Referral got a reply.')
  })

  it('refuses a key the record does not show, and a finding with nothing to keep', async () => {
    await expect(proposalsConfirm.run(ctx, { key: 'outcome:sourceFunnel:made-up' })).rejects.toMatchObject({ status: 404 })
    await expect(proposalsConfirm.run(ctx, { key: 'outcome:sourceFunnel:job-board' })).rejects.toMatchObject({ status: 404 })
    expect(mem.add).not.toHaveBeenCalled()
  })

  it('a demo workspace cannot keep a change', async () => {
    mem.add.mockRejectedValueOnce(new DemoMemoryWriteRefusedError('u1'))
    await expect(proposalsConfirm.run(ctx, { key: REFERRAL })).rejects.toMatchObject({ status: 403 })
  })

  it('takes only a key', () => {
    expect(proposalsConfirm.input.safeParse({ key: REFERRAL, effect: 'rank.fresh' }).success).toBe(false)
    expect(proposalsDismiss.input.safeParse({}).success).toBe(false)
  })
})
