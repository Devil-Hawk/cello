import { describe, expect, it } from 'vitest'
import type { AdminClient } from '@/lib/harness/types'
import { SupabaseScoringStore, chanceFromRow } from './supabase-store'
import type { AssessmentToStore } from './store'

interface Call {
  table: string
  op: 'select' | 'update' | 'insert' | 'delete' | 'upsert'
  select?: string
  payload?: unknown
  filters: [string, string, unknown][]
}

/** A chainable fake of the parts of the Supabase client the store uses. `rows` answer a select, by table. */
function fakeAdmin(rows: Record<string, unknown[]> = {}) {
  const calls: Call[] = []
  const admin = {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] }
      const builder: Record<string, unknown> = {}
      const done = () => {
        calls.push(call)
        if (call.op !== 'select') return { data: null, error: null }
        const ids = call.filters.find((f) => f[0] === 'job_id' && f[1] === 'in')?.[2] as string[] | undefined
        const all = rows[table] ?? []
        return { data: ids ? all.filter((r) => ids.includes((r as { job_id: string }).job_id)) : all, error: null }
      }
      for (const m of ['eq', 'in', 'lt', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => {
          call.filters.push([String(args[0]), m, args[1]])
          return builder
        }
      }
      builder.select = (cols?: string) => {
        call.select = cols
        return builder
      }
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
  it('writes each verdict to the person\'s own row for the role and never to jobs', async () => {
    const { admin, calls } = fakeAdmin()
    await new SupabaseScoringStore(admin, 'u').saveAssessments('u', [wanted('mine')])
    expect(calls.filter((c) => c.table === 'jobs')).toEqual([])
    const updates = calls.filter((c) => c.op === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].table).toBe('person_roles')
    expect(updates[0].filters).toContainEqual(['user_id', 'eq', 'u'])
    expect(updates[0].filters).toContainEqual(['job_id', 'eq', 'mine'])
    const patch = updates[0].payload as Record<string, unknown>
    expect(patch).toMatchObject({ want_p: 0.7, chance: 'possible', blocked_reasons: [] })
    expect(typeof patch.assessed_at).toBe('string')
    expect(patch.want_detail).toMatchObject({ judge: 0.8, embedding: 0.6, stated: 0.5, statedKey: 'sk', calibrated: false, nReactions: 4 })
    expect(patch.chance_detail).toMatchObject({ gaps: ['Kubernetes'], confirm: ['Authorized to work in the US'], resumeKey: 'rk' })
    expect(Object.keys(patch)).not.toContain('match_score')
    expect(Object.keys(patch)).not.toContain('fit_assessed_at')
  })

  it('only updates: a role the person has no row for is never inserted', async () => {
    const { admin, calls } = fakeAdmin()
    await new SupabaseScoringStore(admin, 'u').saveAssessments('u', [wanted('a'), wanted('b')])
    expect(calls.filter((c) => c.op === 'insert' || c.op === 'upsert')).toEqual([])
    expect(calls.every((c) => c.table === 'person_roles' && c.op === 'update')).toBe(true)
  })

  it('stores a blocked role with its reasons and no want or chance', async () => {
    const { admin, calls } = fakeAdmin()
    const reasons = [{ kind: 'location' as const, text: 'It is based in Germany, and you said you work in the United States.' }]
    await new SupabaseScoringStore(admin, 'u').saveAssessments('u', [{ jobId: 'b', blocked: true, blockedReasons: reasons, want: null, chance: null, wantReason: null, stated: null, resumeKey: null }])
    expect(calls.find((c) => c.op === 'update')!.payload).toMatchObject({ blocked_reasons: reasons, want_p: null, want_reason: null, chance: null, chance_detail: null })
  })

  it('keeps the chance a role already has when it was not checked this time', async () => {
    const { admin, calls } = fakeAdmin()
    await new SupabaseScoringStore(admin, 'u').saveAssessments('u', [wanted('a', { chance: null, resumeKey: null })])
    const patch = calls.find((c) => c.op === 'update')!.payload as Record<string, unknown>
    expect(Object.keys(patch)).not.toContain('chance')
    expect(Object.keys(patch)).not.toContain('chance_detail')
  })

  it('reads earlier assessments from the person\'s own rows', async () => {
    const { admin, calls } = fakeAdmin({
      person_roles: [{ job_id: 'a', want_detail: { stated: 0.4, statedKey: 'sk' }, chance: 'strong', chance_detail: { checks: [], gaps: [], confirm: [], note: null, resumeKey: 'rk' } }],
    })
    const prior = await new SupabaseScoringStore(admin, 'u').priorAssessments('u', ['a', 'b'])
    expect(prior.get('a')).toMatchObject({ statedP: 0.4, statedKey: 'sk', resumeKey: 'rk', chance: { chance: 'strong' } })
    expect(prior.has('b')).toBe(false)
    expect(calls[0].table).toBe('person_roles')
    expect(calls[0].filters).toContainEqual(['user_id', 'eq', 'u'])
  })

  it('takes what a posting asks for from the reader\'s record on the job, never from a model', async () => {
    const record = {
      version: 1,
      source: 'deterministic',
      skills_resolved: true,
      must_have: ['Go', 'PostgreSQL'],
      nice_to_have: [],
      years_experience: { min: 5, max: null },
      seniority: null,
      location: { mode: null, places: [] },
      visa: { sponsorship: 'not_stated', evidence: null },
      salary: null,
    }
    const { admin, calls } = fakeAdmin({
      person_roles: [
        { job_id: 'read', jobs: { requirements: record } },
        { job_id: 'unread', jobs: { requirements: null } },
      ],
    })
    const out = await new SupabaseScoringStore(admin, 'u').requirements('u', ['read', 'unread', 'absent'])
    expect(out.get('read')).toMatchObject({ kind: 'ok' })
    expect(out.get('unread')).toMatchObject({ kind: 'thin' })
    expect(out.has('absent')).toBe(false)
    expect(calls[0].table).toBe('person_roles')
    expect(calls[0].select).toContain('jobs!inner(requirements)')
    expect(calls[0].filters).toContainEqual(['user_id', 'eq', 'u'])
  })

  it('replaces the day\'s list and deletes lists older than 14 days', async () => {
    const { admin, calls } = fakeAdmin()
    await new SupabaseScoringStore(admin, 'u').saveShortlist('u', '2026-10-20', [{ jobId: 'j1', position: 1, kind: 'top', explanation: 'Because.' }])
    const deletes = calls.filter((c) => c.op === 'delete')
    expect(deletes).toHaveLength(2)
    expect(deletes[0].filters).toContainEqual(['for_date', 'eq', '2026-10-20'])
    expect(deletes[1].filters).toContainEqual(['for_date', 'lt', '2026-10-06'])
    expect(calls.find((c) => c.op === 'insert')!.payload).toEqual([{ user_id: 'u', for_date: '2026-10-20', job_id: 'j1', position: 1, pick_kind: 'top', explanation: 'Because.' }])
  })

  it('refuses to act for a different person than it was opened for', async () => {
    const { admin } = fakeAdmin()
    await expect(new SupabaseScoringStore(admin, 'u').reactions('someone-else')).rejects.toThrow('different person')
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
