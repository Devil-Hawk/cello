// The advancer: a lease taken once, a step run once, a failure that lands somewhere named, a rate limit
// that waits for the right time, and what each step decides. The SQL it moves through is checked in
// supabase/checks (pipeline_core.sql, pipeline_sweep.sql: fairness of 2 a person, 10 a minute, stale
// leases); here transition is a recorder.

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const calls: any[] = []
vi.mock('@/lib/pipeline/transition', () => ({
  transition: vi.fn(async (_admin: unknown, m: any) => (calls.push(m), { ok: true, replay: false, event: { id: 'e', kind: m.event.kind } })),
}))

import { advanceOne } from './index'
import { costLine, rateLimitOf, sumCost, waitAfter } from './cost'
import { readGreenhouseFields, type Step } from './steps'

const NOW = Date.parse('2026-10-14T12:00:00Z')

function fakeAdmin(tables: Record<string, Row[]>): any {
  return {
    rpc: async () => ({ data: false, error: null }),
    from(name: string) {
      tables[name] ??= []
      let rows = tables[name]
      let mode: 'select' | 'update' = 'select'
      let patch: Row = {}
      const filters: ((r: Row) => boolean)[] = []
      const run = () => {
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        if (mode === 'update') for (const r of hit) Object.assign(r, patch)
        return { data: hit.map((r) => ({ ...r })), error: null }
      }
      const q: any = {
        select: () => q,
        update: (v: Row) => ((mode = 'update'), (patch = v), q),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        or: (str: string) => {
          // lease_until.is.null,lease_until.lt.<iso>
          const lt = /lease_until\.lt\.(.+)$/.exec(str)?.[1] ?? ''
          filters.push((r) => r.lease_until == null || r.lease_until < lt)
          return q
        },
        limit: () => q,
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => res(run()),
      }
      return q
    },
  }
}

const app = (over: Row = {}): Row => ({
  id: 'a1', user_id: 'u1', job_id: 'j1', state: 'preparing', attempt: 0, last_event_at: null, posting_url_hash: null, lease_until: null,
  jobs: { url: 'https://example.com/jobs/1', title: 'Engineer', company_id: 'c1', closed_at: null, still_open: true, companies: { name: 'Acme' } },
  ...over,
})

const ok = (id: string): Step => ({ id, doing: `Doing ${id}`, run: vi.fn(async () => ({ kind: 'continue' as const, line: `${id} done` })) })

const opts = (steps: Step[]) => ({ now: () => NOW, steps })

beforeEach(() => {
  calls.length = 0
})

describe('advanceOne', () => {
  it('runs every step in order and ends at Ready', async () => {
    const admin = fakeAdmin({ applications: [app()], pipeline_events: [] })
    const steps = [ok('one'), ok('two')]
    await advanceOne(admin, 'a1', opts(steps))
    expect(calls.map((c) => `${c.from}>${c.to}:${c.event.step ?? ''}`)).toEqual(['preparing>preparing:one', 'preparing>preparing:two', 'preparing>ready:ready'])
  })

  it('takes a free or expired lease once, and leaves a live one alone', async () => {
    const expired = fakeAdmin({ applications: [app({ lease_until: new Date(NOW - 60_000).toISOString() })], pipeline_events: [] })
    expect(await advanceOne(expired, 'a1', opts([ok('one')]))).not.toBeNull()
    const live = fakeAdmin({ applications: [app({ lease_until: new Date(NOW + 60_000).toISOString() })], pipeline_events: [] })
    calls.length = 0
    expect(await advanceOne(live, 'a1', opts([ok('one')]))).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('does nothing for an application that is not preparing', async () => {
    expect(await advanceOne(fakeAdmin({ applications: [app({ state: 'ready' })], pipeline_events: [] }), 'a1', opts([ok('one')]))).toBeNull()
  })

  it('does not run a step again that already finished', async () => {
    const steps = [ok('one'), ok('two')]
    const admin = fakeAdmin({ applications: [app()], pipeline_events: [{ user_id: 'u1', idempotency_key: 'step:a1:one:0:done' }] })
    await advanceOne(admin, 'a1', opts(steps))
    expect(steps[0].run).not.toHaveBeenCalled()
    expect(steps[1].run).toHaveBeenCalledTimes(1)
  })

  it('lands a throwing step in a named state: one more try, then Not sent on the third', async () => {
    const boom: Step = { id: 'boom', doing: 'Boom', run: async () => { throw new Error('nope') } }
    await advanceOne(fakeAdmin({ applications: [app({ attempt: 0 })], pipeline_events: [] }), 'a1', opts([boom]))
    expect(calls.at(-1)).toMatchObject({ to: 'preparing', event: { kind: 'step.failed', attemptInc: true } })
    calls.length = 0
    await advanceOne(fakeAdmin({ applications: [app({ attempt: 2 })], pipeline_events: [] }), 'a1', opts([boom]))
    expect(calls.at(-1)).toMatchObject({ to: 'not_sent', event: { kind: 'step.failed' } })
    expect(calls.at(-1).step).toContain('could not finish')
  })

  it('waits on the free daily limit until tomorrow and retries a per-minute limit in a minute', async () => {
    const daily: Step = { id: 'm', doing: 'Model', run: async () => { throw Object.assign(new Error('Rate limit exceeded: free-models-per-day'), { status: 429 }) } }
    await advanceOne(fakeAdmin({ applications: [app()], pipeline_events: [] }), 'a1', opts([daily]))
    expect(calls.at(-1)).toMatchObject({ to: 'scheduled', event: { kind: 'limit.reached', nextAt: '2026-10-15T00:05:00.000Z' } })
    expect(calls.at(-1).step).toBe("The free model's daily limit is reached. Cello will carry on tomorrow.")
    calls.length = 0
    const perMinute: Step = { id: 'm', doing: 'Model', run: async () => { throw Object.assign(new Error('429 Too many requests'), { status: 429 }) } }
    await advanceOne(fakeAdmin({ applications: [app()], pipeline_events: [] }), 'a1', opts([perMinute]))
    expect(calls.at(-1)).toMatchObject({ to: 'scheduled', event: { nextAt: '2026-10-14T12:01:00.000Z' } })
  })

  it('moves to the one thing it waits on, with the reason named', async () => {
    const asks: Step = { id: 'read_form', doing: 'Reading', run: async () => ({ kind: 'wait', reason: 'answer', detail: { answer_ids: ['q1'] }, line: '1 question needs your answer.' }) }
    await advanceOne(fakeAdmin({ applications: [app()], pipeline_events: [] }), 'a1', opts([ok('one'), asks, ok('after')]))
    expect(calls.at(-1)).toMatchObject({ to: 'needs_you', reason: 'answer', detail: { answer_ids: ['q1'] } })
    expect(calls.some((c) => c.event.step === 'after')).toBe(false)
  })
})

describe('the steps', () => {
  it('closes a posting that is closed and waits on Already applied? for a send-blocked one', async () => {
    const { checkOpen, dedupe } = await import('./steps')
    const ctx = (over: Row = {}, blocked = false) => ({ admin: { rpc: async () => ({ data: blocked, error: null }), from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) } as any, app: { id: 'a1', user_id: 'u1', job_id: 'j1', posting_url_hash: 'h' }, job: { url: 'u', title: 't', company_id: 'c', closed_at: null, still_open: true, companyName: 'Acme', ...over }, fetchForm: async () => ({}) })
    expect(await checkOpen.run(ctx({ closed_at: '2026-10-01T00:00:00Z' }))).toMatchObject({ kind: 'close', closedReason: 'posting_closed' })
    expect(await checkOpen.run(ctx())).toMatchObject({ kind: 'continue' })
    expect(await dedupe.run(ctx({}, true))).toMatchObject({ kind: 'wait', reason: 'duplicate' })
    expect(await dedupe.run(ctx({}, false))).toMatchObject({ kind: 'continue' })
  })

  it('reads a Greenhouse question with its options, and skips the file inputs', () => {
    const fields = readGreenhouseFields({
      questions: [
        { label: 'Resume/CV', required: true, fields: [{ name: 'resume', type: 'input_file' }] },
        { label: 'How did you hear about this job?', required: true, fields: [{ name: 'question_1', type: 'multi_value_single_select', values: [{ label: 'LinkedIn', value: 1 }, { label: 'A friend', value: 2 }] }] },
        { label: 'Why us?', required: false, fields: [{ name: 'question_2', type: 'textarea' }] },
      ],
    })
    expect(fields).toEqual([
      { id: 'question_1', label: 'How did you hear about this job?', required: true, kind: 'select', options: ['LinkedIn', 'A friend'] },
      { id: 'question_2', label: 'Why us?', required: false, kind: 'long_text', options: undefined },
    ])
  })
})

describe('cost', () => {
  it('sums free and paid rows apart, and says Free when nothing cost anything', () => {
    const c = sumCost([{ cost_usd: 0, free_model: true }, { cost_usd: 0, free_model: true }, { cost_usd: 0.0312, free_model: false }, { cost_usd: null, free_model: null }])
    expect(c).toEqual({ usd: 0.0312, free: 2, paid: 1 })
    expect(costLine(c)).toBe('$0.03')
    expect(costLine(sumCost([{ cost_usd: 0, free_model: true }]))).toBe('Free')
    expect(costLine(sumCost([]))).toBe('')
  })

  it('tells a daily limit from a per-minute one, and nothing else from either', () => {
    expect(rateLimitOf(Object.assign(new Error('free-models-per-day'), { status: 429 }))).toBe('daily')
    expect(rateLimitOf(Object.assign(new Error('slow down'), { status: 429 }))).toBe('minute')
    expect(rateLimitOf(new Error('boom'))).toBeNull()
    expect(waitAfter('minute', new Date(NOW)).nextAt).toBe('2026-10-14T12:01:00.000Z')
  })
})
