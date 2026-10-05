import { describe, expect, it } from 'vitest'
import type { AdminClient } from '@/lib/harness/types'
import { EXTRACTOR_VERSION } from './requirements'
import { SupabaseScoringStore, chanceFromRow, fromStoredRequirements, toStoredRequirements } from './supabase-store'
import type { AssessmentToStore } from './store'

interface Call {
  table: string
  op: 'select' | 'update' | 'insert' | 'delete' | 'upsert'
  payload?: unknown
  filters: [string, string, unknown][]
}

/** A chainable fake of the parts of the Supabase client the store uses. `owned` are the job ids the person owns. */
function fakeAdmin(opts: { owned: string[]; rows?: Record<string, unknown[]> }) {
  const calls: Call[] = []
  const admin = {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] }
      const builder: Record<string, unknown> = {}
      const done = () => {
        calls.push(call)
        if (table === 'jobs' && call.op === 'select') {
          const ids = (call.filters.find((f) => f[0] === 'id' && f[1] === 'in')?.[2] as string[] | undefined) ?? []
          const rows = ids.filter((id) => opts.owned.includes(id)).map((id) => ({ id, ...((opts.rows?.jobs?.find((r) => (r as { id: string }).id === id) as object) ?? {}) }))
          return { data: rows, error: null }
        }
        return { data: opts.rows?.[table] ?? [], error: null }
      }
      const chain = () => builder
      for (const m of ['eq', 'in', 'lt', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => {
          call.filters.push([String(args[0]), m, args[1]])
          return builder
        }
      }
      builder.select = () => chain()
      builder.update = (payload: unknown) => {
        call.op = 'update'
        call.payload = payload
        return builder
      }
      builder.insert = (payload: unknown) => {
        call.op = 'insert'
        call.payload = payload
        return builder
      }
      builder.upsert = (payload: unknown) => {
        call.op = 'upsert'
        call.payload = payload
        return builder
      }
      builder.delete = () => {
        call.op = 'delete'
        return builder
      }
      builder.maybeSingle = async () => ({ data: null, error: null })
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(done()).then(resolve)
      return builder
    },
  }
  return { admin: admin as unknown as AdminClient, calls }
}

const wanted = (id: string, over: Partial<AssessmentToStore> = {}): AssessmentToStore => ({
  jobId: id,
  blocked: false,
  blockedReasons: [],
  want: { p: 0.7, reason: 'Payments work like what you liked.', calibrated: false, components: { judge: 0.8, embedding: 0.6, stated: 0.5 }, nReactions: 4 },
  chance: { chance: 'possible', checks: [], gaps: ['Kubernetes'], confirm: ['Authorized to work in the US'], note: '2 of 3' },
  wantReason: 'Payments work like what you liked.',
  stated: { p: 0.5, key: 'sk' },
  resumeKey: 'rk',
  ...over,
})

describe('SupabaseScoringStore', () => {
  it('writes assessments to jobs, and only to jobs the person owns', async () => {
    const { admin, calls } = fakeAdmin({ owned: ['mine'] })
    await new SupabaseScoringStore(admin, 'u').saveAssessments('u', [wanted('mine'), wanted('theirs')])
    const updates = calls.filter((c) => c.op === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].table).toBe('jobs')
    expect(updates[0].filters).toContainEqual(['id', 'eq', 'mine'])
    const patch = updates[0].payload as Record<string, unknown>
    expect(patch).toMatchObject({ want_p: 0.7, chance: 'possible', blocked_reasons: [] })
    expect(patch.want_detail).toMatchObject({ judge: 0.8, embedding: 0.6, stated: 0.5, statedKey: 'sk', calibrated: false, nReactions: 4 })
    expect(patch.chance_detail).toMatchObject({ gaps: ['Kubernetes'], confirm: ['Authorized to work in the US'], resumeKey: 'rk' })
    expect(Object.keys(patch)).not.toContain('match_score')
    // Ownership was checked through the companies join, not by a list of company ids.
    expect(calls.find((c) => c.table === 'jobs' && c.op === 'select')!.filters).toContainEqual(['companies.user_id', 'eq', 'u'])
  })

  it('stores a blocked role with its reasons and no want or chance', async () => {
    const { admin, calls } = fakeAdmin({ owned: ['b'] })
    const reasons = [{ kind: 'location' as const, text: 'It is based in Germany, and you said you work in the United States.' }]
    await new SupabaseScoringStore(admin, 'u').saveAssessments('u', [{ jobId: 'b', blocked: true, blockedReasons: reasons, want: null, chance: null, wantReason: null, stated: null, resumeKey: null }])
    expect(calls.find((c) => c.op === 'update')!.payload).toMatchObject({ blocked_reasons: reasons, want_p: null, want_reason: null, chance: null, chance_detail: null })
  })

  it('keeps the chance a role already has when it was not checked this time', async () => {
    const { admin, calls } = fakeAdmin({ owned: ['a'] })
    await new SupabaseScoringStore(admin, 'u').saveAssessments('u', [wanted('a', { chance: null, resumeKey: null })])
    const patch = calls.find((c) => c.op === 'update')!.payload as Record<string, unknown>
    expect(Object.keys(patch)).not.toContain('chance')
    expect(Object.keys(patch)).not.toContain('chance_detail')
  })

  it('never writes a failed requirement read', async () => {
    const { admin, calls } = fakeAdmin({ owned: ['a', 'b'] })
    await new SupabaseScoringStore(admin, 'u').saveRequirements(
      'u',
      new Map([
        ['a', { kind: 'failed' as const, reason: 'timeout' }],
        ['b', { kind: 'thin' as const, reason: 'No description.' }],
      ])
    )
    const updates = calls.filter((c) => c.op === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].filters).toContainEqual(['id', 'eq', 'b'])
    expect(updates[0].payload).toEqual({ requirement_items: { version: EXTRACTOR_VERSION, kind: 'thin', reason: 'No description.' } })
    const none = fakeAdmin({ owned: ['a'] })
    await new SupabaseScoringStore(none.admin, 'u').saveRequirements('u', new Map([['a', { kind: 'failed' as const, reason: 'x' }]]))
    expect(none.calls).toHaveLength(0)
  })

  it('replaces the day\'s list and deletes lists older than 14 days', async () => {
    const { admin, calls } = fakeAdmin({ owned: [] })
    await new SupabaseScoringStore(admin, 'u').saveShortlist('u', '2026-10-20', [{ jobId: 'j1', position: 1, kind: 'top', explanation: 'Because.' }])
    const deletes = calls.filter((c) => c.op === 'delete')
    expect(deletes).toHaveLength(2)
    expect(deletes[0].filters).toContainEqual(['for_date', 'eq', '2026-10-20'])
    expect(deletes[1].filters).toContainEqual(['for_date', 'lt', '2026-10-06'])
    expect(calls.find((c) => c.op === 'insert')!.payload).toEqual([{ user_id: 'u', for_date: '2026-10-20', job_id: 'j1', position: 1, pick_kind: 'top', explanation: 'Because.' }])
  })

  it('refuses to act for a different person than it was opened for', async () => {
    const { admin } = fakeAdmin({ owned: [] })
    await expect(new SupabaseScoringStore(admin, 'u').reactions('someone-else')).rejects.toThrow('different person')
  })
})

describe('stored requirements', () => {
  it('round-trips and drops what an older extractor read', () => {
    const outcome = { kind: 'ok' as const, requirements: [{ id: 'r1', text: 'Go', kind: 'skill' as const, mustHave: true, quote: 'Strong Go' }] }
    expect(fromStoredRequirements(toStoredRequirements(outcome))).toEqual(outcome)
    expect(fromStoredRequirements({ ...toStoredRequirements(outcome), version: EXTRACTOR_VERSION - 1 })).toBeNull()
    expect(fromStoredRequirements(null)).toBeNull()
  })
})

describe('chanceFromRow', () => {
  it('reads a stored chance with its resume key and tolerates a missing detail', () => {
    expect(chanceFromRow('strong', { checks: [], gaps: ['a'], confirm: [], note: 'n', resumeKey: 'k' })).toMatchObject({ result: { chance: 'strong', gaps: ['a'] }, resumeKey: 'k' })
    expect(chanceFromRow('possible', null)!.result.gaps).toEqual([])
    expect(chanceFromRow(null, null)).toBeNull()
    expect(chanceFromRow('banana', {} as unknown)).toBeNull()
  })
})
