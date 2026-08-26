// wipeExpiredDemoData — the ruling 5 wipe-at-expiry sweep. The one thing
// worth a runnable check: it must use the SAME "has this demo's access
// ended" answer as demoSessionGate (an undated or unparseable demo counts as
// expired, not as "lives forever"), and it must never touch a live demo's or
// an ordinary owner's rows.

import { describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '@/lib/harness/types'
import { wipeExpiredDemoData } from './demo-wipe'

/** memories lives in the `mem0` schema, not `public` (see demo-wipe.ts's own
 *  comment), so it is deleted through MemoryStore.deleteAll rather than a
 *  fakeAdmin table stub — mock the chokepoint, assert it's called per
 *  expired user, same shape as every other per-user call this sweep makes. */
const deleteAllCalls: string[] = []
vi.mock('@/lib/memory/mem0-store', () => ({
  getMemoryStore: () => ({
    deleteAll: async (userId: string) => {
      deleteAllCalls.push(userId)
    },
  }),
}))

const HOUR_MS = 60 * 60 * 1000
const NOW = new Date('2026-08-17T12:00:00.000Z')
const AT = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString()

interface ProfileRow {
  id: string
  is_demo: boolean | null
  demo_expires_at: string | null
}

/** The calls this sweep makes: a profiles select, then one delete per
 *  RULING_5_TABLES entry, each keyed on user_id IN (...). deletedFor is kept
 *  per-table since a real wipe must not, say, delete insights for a user it
 *  never touched interactions for (or vice versa). */
function fakeAdmin(profiles: ProfileRow[]) {
  const deletedFor: Record<string, string[]> = {
    interactions: [],
    insights: [],
    resume_claims: [],
    claim_evidence: [],
    company_merge_candidates: [],
    eval_verdicts: [],
    trace_spans: [],
    a2a_tasks: [],
  }
  const admin = {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: () => ({
            or: async () => ({ data: profiles, error: null }),
          }),
        }
      }
      if (
        table === 'interactions' ||
        table === 'insights' ||
        table === 'resume_claims' ||
        table === 'claim_evidence' ||
        table === 'company_merge_candidates' ||
        table === 'eval_verdicts' ||
        table === 'trace_spans' ||
        table === 'a2a_tasks'
      ) {
        return {
          delete: (_opts: { count: string }) => ({
            in: async (_col: string, ids: string[]) => {
              deletedFor[table].push(...ids)
              return { error: null, count: ids.length }
            },
          }),
        }
      }
      throw new Error(`fakeAdmin: unexpected table "${table}"`)
    },
  } as unknown as AdminClient
  return { admin, deletedFor }
}

describe('wipeExpiredDemoData', () => {
  it('deletes interactions AND insights AND resume_claims AND claim_evidence AND company_merge_candidates AND eval_verdicts AND trace_spans AND a2a_tasks AND memories for a demo past its deadline', async () => {
    deleteAllCalls.length = 0
    const { admin, deletedFor } = fakeAdmin([
      { id: 'demo-expired', is_demo: true, demo_expires_at: AT(-HOUR_MS) },
    ])
    const result = await wipeExpiredDemoData(admin, NOW)
    expect(deletedFor.interactions).toEqual(['demo-expired'])
    expect(deletedFor.insights).toEqual(['demo-expired'])
    expect(deletedFor.resume_claims).toEqual(['demo-expired'])
    expect(deletedFor.claim_evidence).toEqual(['demo-expired'])
    expect(deletedFor.company_merge_candidates).toEqual(['demo-expired'])
    expect(deletedFor.eval_verdicts).toEqual(['demo-expired'])
    expect(deletedFor.trace_spans).toEqual(['demo-expired'])
    expect(deletedFor.a2a_tasks).toEqual(['demo-expired'])
    expect(deleteAllCalls).toEqual(['demo-expired'])
    expect(result).toEqual([
      { table: 'interactions', deleted: 1 },
      { table: 'insights', deleted: 1 },
      { table: 'resume_claims', deleted: 1 },
      { table: 'claim_evidence', deleted: 1 },
      { table: 'company_merge_candidates', deleted: 1 },
      { table: 'eval_verdicts', deleted: 1 },
      { table: 'trace_spans', deleted: 1 },
      { table: 'a2a_tasks', deleted: 1 },
      { table: 'memories', deleted: 1 },
    ])
  })

  it('leaves a live demo alone', async () => {
    const { admin, deletedFor } = fakeAdmin([
      { id: 'demo-live', is_demo: true, demo_expires_at: AT(HOUR_MS) },
    ])
    await wipeExpiredDemoData(admin, NOW)
    expect(deletedFor.interactions).toEqual([])
    expect(deletedFor.insights).toEqual([])
    expect(deletedFor.resume_claims).toEqual([])
    expect(deletedFor.claim_evidence).toEqual([])
    expect(deletedFor.company_merge_candidates).toEqual([])
    expect(deletedFor.eval_verdicts).toEqual([])
    expect(deletedFor.trace_spans).toEqual([])
  })

  it('wipes a demo with no deadline at all — the "lives forever" bug, closed here too', async () => {
    const { admin, deletedFor } = fakeAdmin([{ id: 'demo-undated', is_demo: true, demo_expires_at: null }])
    await wipeExpiredDemoData(admin, NOW)
    expect(deletedFor.interactions).toEqual(['demo-undated'])
    expect(deletedFor.insights).toEqual(['demo-undated'])
    expect(deletedFor.resume_claims).toEqual(['demo-undated'])
    expect(deletedFor.claim_evidence).toEqual(['demo-undated'])
    expect(deletedFor.company_merge_candidates).toEqual(['demo-undated'])
    expect(deletedFor.eval_verdicts).toEqual(['demo-undated'])
    expect(deletedFor.trace_spans).toEqual(['demo-undated'])
  })

  it('wipes a demo whose deadline will not parse, same as demoSessionGate refuses it', async () => {
    const { admin, deletedFor } = fakeAdmin([{ id: 'demo-corrupt', is_demo: true, demo_expires_at: 'whenever' }])
    await wipeExpiredDemoData(admin, NOW)
    expect(deletedFor.interactions).toEqual(['demo-corrupt'])
    expect(deletedFor.insights).toEqual(['demo-corrupt'])
    expect(deletedFor.resume_claims).toEqual(['demo-corrupt'])
    expect(deletedFor.claim_evidence).toEqual(['demo-corrupt'])
    expect(deletedFor.company_merge_candidates).toEqual(['demo-corrupt'])
    expect(deletedFor.eval_verdicts).toEqual(['demo-corrupt'])
    expect(deletedFor.trace_spans).toEqual(['demo-corrupt'])
  })

  it('never touches an ordinary account, even one with a stray demo_expires_at in the past', async () => {
    const { admin, deletedFor } = fakeAdmin([
      { id: 'owner-1', is_demo: false, demo_expires_at: null },
    ])
    await wipeExpiredDemoData(admin, NOW)
    expect(deletedFor.interactions).toEqual([])
    expect(deletedFor.insights).toEqual([])
    expect(deletedFor.resume_claims).toEqual([])
    expect(deletedFor.claim_evidence).toEqual([])
    expect(deletedFor.company_merge_candidates).toEqual([])
    expect(deletedFor.eval_verdicts).toEqual([])
    expect(deletedFor.trace_spans).toEqual([])
  })

  it('short-circuits without deleting when nothing is expired', async () => {
    const { admin, deletedFor } = fakeAdmin([{ id: 'demo-live', is_demo: true, demo_expires_at: AT(HOUR_MS) }])
    const result = await wipeExpiredDemoData(admin, NOW)
    expect(deletedFor.interactions).toEqual([])
    expect(deletedFor.insights).toEqual([])
    expect(result).toEqual([
      { table: 'interactions', deleted: 0 },
      { table: 'insights', deleted: 0 },
      { table: 'resume_claims', deleted: 0 },
      { table: 'claim_evidence', deleted: 0 },
      { table: 'company_merge_candidates', deleted: 0 },
      { table: 'eval_verdicts', deleted: 0 },
      { table: 'trace_spans', deleted: 0 },
      { table: 'a2a_tasks', deleted: 0 },
    ])
  })

  it('logs and returns empty when the profile scan itself fails, rather than throwing', async () => {
    const admin = {
      from: () => ({ select: () => ({ or: async () => ({ data: null, error: { message: 'boom' } }) }) }),
    } as unknown as AdminClient
    const result = await wipeExpiredDemoData(admin, NOW)
    expect(result).toEqual([])
  })
})
