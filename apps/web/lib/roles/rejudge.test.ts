import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { EMPTY_TARGETING } from '../targeting'
import { NO_CONSTRAINTS } from '../scoring/constraints'
import { rejudgePerson } from './rejudge'

const START = Date.parse('2026-10-08T12:00:00Z')
type Admin = SupabaseClient<any, any, any>

describe('rejudgePerson: after a change of targets', () => {
  const job = (title: string, over: Record<string, unknown> = {}) => ({
    title,
    job_function: 'engineering',
    seniority: null,
    country: 'US',
    language: null,
    is_remote: null,
    posted_at: new Date(START - 86_400_000).toISOString(),
    employer_id: 'emp-1',
    company_id: 'co-1',
    ...over,
  })
  interface Held { job_id: string; saved_at: string | null; hidden_reason: string | null; targets_version: number; jobs: ReturnType<typeof job> }

  /** The person_roles, applications, person_jobs (the viewer's own company name by job id) and set_person_counts the re-judge touches, in memory. */
  function store(held: Held[], appliedTo: string[] = [], viewers: Record<string, string> = {}) {
    const rpcs: { name: string; args: Record<string, any> }[] = []
    const selects: string[] = []
    const admin = {
      from(table: string) {
        const filters: ((r: any) => boolean)[] = []
        let op: 'select' | 'delete' | 'update' = 'select'
        let patch: Record<string, unknown> = {}
        const b: any = {
          select: (cols: string) => (table === 'person_roles' && selects.push(cols), b),
          delete: () => ((op = 'delete'), b),
          update: (p: Record<string, unknown>) => ((op = 'update'), (patch = p), b),
          eq: (c: string, v: unknown) => (filters.push((r) => c === 'user_id' || r[c] === v), b),
          in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
          lt: (c: string, v: number) => (filters.push((r) => r[c] < v), b),
          order: () => b,
          limit: () => b,
          then(resolve: (v: unknown) => void) {
            if (table === 'applications') return resolve({ data: appliedTo.map((job_id) => ({ job_id })), error: null })
            if (table === 'person_jobs') return resolve({ data: Object.entries(viewers).map(([id, viewer_company_name]) => ({ id, viewer_company_name })), error: null })
            const hit = held.filter((r) => filters.every((f) => f(r)))
            if (op === 'delete') for (const r of hit) held.splice(held.indexOf(r), 1)
            if (op === 'update') for (const r of hit) Object.assign(r, patch)
            resolve({ data: op === 'select' ? hit.slice(0, 500) : null, error: null })
          },
        }
        return b
      },
      rpc: async (name: string, args: Record<string, any>) => (rpcs.push({ name, args }), { data: 1, error: null }),
    }
    return { admin: admin as unknown as Admin, rpcs, held, selects }
  }

  const targets = (over: Record<string, unknown> = {}) => ({
    targeting: { ...EMPTY_TARGETING, countries: ['US'], ...over },
    titles: [],
    version: 2,
  })
  const row = (id: string, over: Partial<Held> = {}): Held => ({ job_id: id, saved_at: null, hidden_reason: null, targets_version: 1, jobs: job(id), ...over })

  it('removes and counts a held role now outside, and keeps a saved one, an applied one and one the person set aside', async () => {
    const { admin, rpcs, held } = store(
      [
        row('gone', { jobs: job('Engineer', { country: 'DE' }) }),
        row('saved', { jobs: job('Engineer', { country: 'DE' }), saved_at: '2026-10-01T00:00:00Z' }),
        row('applied', { jobs: job('Engineer', { country: 'DE' }) }),
        row('aside', { jobs: job('Engineer', { country: 'DE' }), hidden_reason: 'not_for_me' }),
        row('inside'),
      ],
      ['applied']
    )
    const out = await rejudgePerson(admin, 'u1', { targets: targets(), now: () => START, deadlineAt: START + 200_000 })
    expect(out).toEqual({ checked: 5, removed: 1 })
    expect(held.map((r) => r.job_id).sort()).toEqual(['applied', 'aside', 'inside', 'saved'])
    expect(held.every((r) => r.targets_version === 2)).toBe(true)
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0].args.p_rows).toEqual([{ employer_id: 'emp-1', company_id: null, kind: 'outside_targets', reason: 'place', n: 1 }])
  })

  it('drops an excluded-company role the sweep stored with no company, named by its employer', async () => {
    const { admin, held } = store(
      [
        row('owned', { jobs: job('Engineer') }),
        row('swept', { jobs: { ...job('Engineer'), company_id: null, employer: { name: 'Overlap Co' } } as never }),
        row('other', { jobs: { ...job('Engineer'), company_id: null, employer: { name: 'Fine Inc' } } as never }),
      ],
      [],
      { owned: 'Overlap Co' }
    )
    const out = await rejudgePerson(admin, 'u1', { targets: targets({ excludedCompanies: ['overlap'] }), now: () => START, deadlineAt: START + 200_000 })
    expect(out).toEqual({ checked: 3, removed: 2 })
    expect(held.map((r) => r.job_id)).toEqual(['other'])
  })

  it("judges a shared role by the viewer's own company name, never the company that stored it first", async () => {
    // stored under another person's company 'Overlap Co' (what a companies(...) embed would return); this person follows the employer as 'Fine Inc'
    const stored = (over: Record<string, unknown> = {}) => ({ ...job('Engineer'), companies: { name: 'Overlap Co' }, employer: { name: 'Overlap Co' }, ...over }) as never
    const { admin, held, selects } = store([row('theirs', { jobs: stored() })], [], { theirs: 'Fine Inc' })
    const out = await rejudgePerson(admin, 'u1', { targets: targets({ excludedCompanies: ['overlap'] }), now: () => START, deadlineAt: START + 200_000 })
    expect(out).toEqual({ checked: 1, removed: 0 })
    expect(held.map((r) => r.job_id)).toEqual(['theirs'])
    expect(selects.every((s) => !s.includes('companies('))).toBe(true)
    // and their own company still excludes: the viewer's name is the one judged
    const own = store([row('mine', { jobs: stored({ employer: null }) })], [], { mine: 'Overlap Co' })
    expect(await rejudgePerson(own.admin, 'u1', { targets: targets({ excludedCompanies: ['overlap'] }), now: () => START, deadlineAt: START + 200_000 })).toEqual({ checked: 1, removed: 1 })
  })

  it('leaves roles already under the current version alone, and does nothing for a person with no saved targets', async () => {
    const { admin, held } = store([row('a', { targets_version: 2, jobs: job('Engineer', { country: 'DE' }) })])
    expect(await rejudgePerson(admin, 'u1', { targets: targets(), now: () => START, deadlineAt: START + 200_000 })).toEqual({ checked: 0, removed: 0 })
    expect(held).toHaveLength(1)
    expect(await rejudgePerson(admin, 'u1', { targets: { ...targets(), version: 0 }, now: () => START, deadlineAt: START + 200_000 })).toEqual({ checked: 0, removed: 0 })
  })

  it('does not drop a role when the person has stated nothing, and moves it to the new version', async () => {
    const { admin, held } = store([row('a', { jobs: job('Engineer', { country: 'DE' }) })])
    const none = { targeting: EMPTY_TARGETING, titles: [], version: 2 }
    expect(await rejudgePerson(admin, 'u1', { targets: none, now: () => START, deadlineAt: START + 200_000 })).toEqual({ checked: 1, removed: 0 })
    expect(held).toMatchObject([{ job_id: 'a', targets_version: 2 }])
  })

  it('reads the description for an excluded word, and counts a broken dealbreaker as dealbreaker', async () => {
    const { admin, held, rpcs } = store([
      row('crypto', { jobs: { ...job('Engineer'), description: 'We build crypto rails.' } as never }),
      row('nosponsor', { jobs: { ...job('Engineer'), description: 'We cannot provide visa sponsorship.' } as never }),
      row('lowpay', { jobs: { ...job('Engineer'), salary_range: '$80,000 - $100,000' } as never }),
      row('fine'),
    ])
    const t = { ...targets({ excludedKeywords: ['crypto'] }), constraints: { ...NO_CONSTRAINTS, needsSponsorship: true, salaryFloorUsd: 150_000 } }
    const out = await rejudgePerson(admin, 'u1', { targets: t, now: () => START, deadlineAt: START + 200_000 })
    expect(out).toEqual({ checked: 4, removed: 3 })
    expect(held.map((r) => r.job_id)).toEqual(['fine'])
    const byReason = Object.fromEntries((rpcs[0].args.p_rows as { reason: string; n: number }[]).map((c) => [c.reason, c.n]))
    expect(byReason).toEqual({ excluded: 1, dealbreaker: 2 })
  })

  it('goes through every page of 100 until nothing is held under an older version', async () => {
    const many = Array.from({ length: 230 }, (_, i) => row(`r${String(i).padStart(3, '0')}`, { jobs: job('Engineer', { country: i % 2 ? 'DE' : 'US' }) }))
    const { admin, held } = store(many)
    const out = await rejudgePerson(admin, 'u1', { targets: targets(), now: () => START, deadlineAt: START + 200_000 })
    expect(out).toEqual({ checked: 230, removed: 115 })
    expect(held).toHaveLength(115)
    expect(held.every((r) => r.targets_version === 2)).toBe(true)
  })
})
