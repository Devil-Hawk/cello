import { beforeEach, describe, expect, it } from 'vitest'
import type { AdminClient } from '@/lib/harness/types'
import { ScoringInputError, getRoleFit, learningMode, readShortlist, receiptFor, todayUtc, triageRole, undoReaction } from './index'

type Row = Record<string, unknown>

/** A small in-memory stand-in for the parts of the Supabase client the module uses. */
function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  let nextId = 1
  const db = {
    tables,
    from(name: string) {
      const rows = (tables[name] ??= [])
      const filters: ((r: Row) => boolean)[] = []
      let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
      let payload: Row | Row[] | null = null
      let conflict: string[] = []
      let countOnly = false
      const b: Record<string, unknown> = {}
      const get = (r: Row, col: string): unknown => (col === 'companies.user_id' ? r._owner : r[col])
      const run = () => {
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        if (op === 'insert') {
          for (const p of [payload].flat() as Row[]) rows.push({ id: `row${nextId++}`, ...p })
          return { data: null, error: null }
        }
        if (op === 'upsert') {
          const p = payload as Row
          const existing = rows.find((r) => conflict.every((c) => r[c] === p[c]))
          if (existing) Object.assign(existing, p)
          else rows.push({ id: `row${nextId++}`, ...p })
          return { data: null, error: null }
        }
        if (op === 'update') {
          for (const r of hit) Object.assign(r, payload)
          return { data: null, error: null }
        }
        if (op === 'delete') {
          for (const r of hit) rows.splice(rows.indexOf(r), 1)
          return { data: null, error: null }
        }
        return { data: hit.map((r) => ({ ...r })), error: null, count: hit.length, countOnly }
      }
      b.select = (_cols?: string, opts?: { head?: boolean }) => {
        countOnly = Boolean(opts?.head)
        return b
      }
      b.eq = (col: string, v: unknown) => (filters.push((r) => get(r, col) === v), b)
      b.neq = (col: string, v: unknown) => (filters.push((r) => JSON.stringify(get(r, col)) !== JSON.stringify(JSON.parse(String(v)))), b)
      b.in = (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(get(r, col))), b)
      b.is = (col: string, v: unknown) => (filters.push((r) => (v === null ? get(r, col) == null : get(r, col) === v)), b)
      b.not = (col: string, _o: string, v: unknown) => (filters.push((r) => (v === null ? get(r, col) != null : get(r, col) !== v)), b)
      b.order = () => b
      b.limit = () => b
      b.insert = (p: Row | Row[]) => ((op = 'insert'), (payload = p), b)
      b.upsert = (p: Row, o?: { onConflict?: string }) => ((op = 'upsert'), (payload = p), (conflict = (o?.onConflict ?? '').split(',')), b)
      b.update = (p: Row) => ((op = 'update'), (payload = p), b)
      b.delete = () => ((op = 'delete'), b)
      b.maybeSingle = async () => {
        const r = run()
        return { data: (r.data as Row[] | null)?.[0] ?? null, error: null }
      }
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve)
      return b
    },
  }
  return db as unknown as AdminClient & { tables: Record<string, Row[]> }
}

const JOB = {
  id: 'job1',
  _owner: 'u',
  title: 'Senior Backend Engineer',
  location: 'Seattle, WA',
  description: 'Build payment services in Go.',
  companies: { name: 'Acme' },
  is_new: true,
  want_p: 0.7,
  want_detail: { judge: 0.8, embedding: 0.6, stated: 0.5 },
  chance: 'possible',
  want_reason: 'Payments work.',
  chance_detail: { checks: [], gaps: [], confirm: [], note: null },
  blocked_reasons: [],
}

let db: ReturnType<typeof fakeDb>
beforeEach(() => {
  db = fakeDb({ jobs: [JOB, { ...JOB, id: 'other', _owner: 'someone-else' }], role_reactions: [], applications: [] })
})

const triage = (over: Partial<Parameters<typeof triageRole>[0]> = {}) => triageRole({ db, userId: 'u', jobId: 'job1', reaction: 'interested', surface: 'today', ...over })

describe('triageRole', () => {
  it('Interested saves the role to Pipeline as discovered with source triage, and snapshots what Cello predicted', async () => {
    const out = await triage({ pickKind: 'explore' })
    expect(out.receipt).toBe('Saved to Pipeline. Cello will show more like this.')
    expect(db.tables.applications).toHaveLength(1)
    expect(db.tables.applications[0]).toMatchObject({ user_id: 'u', job_id: 'job1', stage: 'discovered', source: 'triage' })
    expect(db.tables.role_reactions[0]).toMatchObject({
      reaction: 'interested',
      reason: null,
      surface: 'today',
      pick_kind: 'explore',
      job_title: 'Senior Backend Engineer',
      company_name: 'Acme',
      predicted: { judge: 0.8, embedding: 0.6, stated: 0.5, blended: 0.7, chance: 'possible' },
    })
    expect(String(db.tables.role_reactions[0].job_text)).toContain('Build payment services in Go.')
  })

  it('does not save a second application, and reacting twice keeps one reaction', async () => {
    await triage()
    await triage({ reaction: 'applied' })
    expect(db.tables.applications).toHaveLength(1)
    expect(db.tables.applications[0]).toMatchObject({ stage: 'applied' })
    expect(db.tables.role_reactions).toHaveLength(1)
    expect(db.tables.role_reactions[0]).toMatchObject({ reaction: 'applied' })
  })

  it('Not for me stores the reason and removes only an application that triage itself created', async () => {
    await triage()
    const out = await triage({ reaction: 'not_for_me', reason: 'pay' })
    expect(out.receipt).toBe('Got it. Pay noted for this one; it will not count against similar roles.')
    expect(db.tables.role_reactions[0]).toMatchObject({ reaction: 'not_for_me', reason: 'pay' })
    expect(db.tables.applications).toHaveLength(0)
    expect(db.tables.jobs[0]).toMatchObject({ is_new: false })

    const mine = fakeDb({ jobs: [JOB], role_reactions: [], applications: [{ id: 'a1', user_id: 'u', job_id: 'job1', stage: 'discovered', source: 'manual' }] })
    await triageRole({ db: mine, userId: 'u', jobId: 'job1', reaction: 'not_for_me', surface: 'opportunities' })
    expect(mine.tables.applications).toHaveLength(1)
  })

  it('rejects a reason on anything but a pass, an unknown reason, and a role that is not the person\'s', async () => {
    await expect(triage({ reason: 'pay' })).rejects.toThrow(ScoringInputError)
    await expect(triage({ reaction: 'not_for_me', reason: 'banana' as never })).rejects.toThrow('not one Cello knows')
    await expect(triage({ jobId: 'other' })).rejects.toThrow('not found')
    expect(db.tables.role_reactions).toHaveLength(0)
  })
})

describe('undoReaction', () => {
  it('takes the reaction and the Pipeline entry triage made back, and makes a passed role new again', async () => {
    await triage({ reaction: 'not_for_me' })
    expect((await undoReaction({ db, userId: 'u', jobId: 'job1' })).undone).toBe(true)
    expect(db.tables.role_reactions).toHaveLength(0)
    expect(db.tables.jobs[0]).toMatchObject({ is_new: true })

    await triage()
    expect(db.tables.applications).toHaveLength(1)
    await undoReaction({ db, userId: 'u', jobId: 'job1' })
    expect(db.tables.applications).toHaveLength(0)
    expect((await undoReaction({ db, userId: 'u', jobId: 'job1' })).undone).toBe(false)
  })
})

describe('receipts and modes', () => {
  it('words each receipt in the person\'s terms', () => {
    expect(receiptFor('not_for_me', 'domain')).toBe('Got it. Fewer roles in this area.')
    expect(receiptFor('not_for_me', null)).toBe('Got it. Cello will show fewer like this.')
    expect(receiptFor('applied', null)).toContain('applied')
  })

  it('says how the list was ranked', () => {
    expect(learningMode(0, false)).toBe('stated')
    expect(learningMode(2, false)).toBe('stated')
    expect(learningMode(8, false)).toBe('learning')
    expect(learningMode(30, true)).toBe('calibrated')
    expect(todayUtc(new Date('2026-10-06T23:59:00Z'))).toBe('2026-10-06')
  })
})

describe('reading', () => {
  it('reads the verdict of one of the person\'s roles and nothing for anyone else\'s', async () => {
    const fit = await getRoleFit(db, 'u', 'job1')
    expect(fit?.want?.tier).toBe('high')
    expect(fit?.chance?.label).toBe('possible')
    expect(await getRoleFit(db, 'u', 'other')).toBeNull()
  })

  it('reports a day with no saved list as not built, and a saved list with each role and reaction', async () => {
    const empty = await readShortlist(db, 'u', '2026-10-06')
    expect(empty.status).toBe('not_built')
    db.tables.shortlist_items = [{ user_id: 'u', for_date: '2026-10-06', job_id: 'job1', position: 1, pick_kind: 'top', explanation: 'Payments work, and it is within reach.' }]
    await triage()
    const ready = await readShortlist(db, 'u', '2026-10-06')
    expect(ready.status).toBe('ready')
    expect(ready.picks[0]).toMatchObject({ position: 1, kind: 'top', job: { id: 'job1', company: 'Acme' }, reaction: { reaction: 'interested' } })
    expect(ready.picks[0].fit?.want?.tier).toBe('high')
  })
})
