import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fakeDb } from '@/lib/companies/fake-db'
import { Bucket, dayShare, judgeCall, type DoorDeps } from './free-door'

const schema = z.object({ ok: z.literal(true) })
const answer = (model: string, content = '{"ok":true}') => ({ content, model, promptTokens: 1, completionTokens: 1, tokensUsed: 2 })
const NOW = new Date('2026-10-22T10:00:00Z')

function setup(opts: { keys?: Record<string, unknown>; platform?: string | undefined; selfHosted?: boolean; cap?: number; perMinute?: number; waiting?: string[]; replies?: (model: string | undefined) => unknown } = {}) {
  const budget = { used: 0, mine: {} as Record<string, number>, args: [] as Record<string, unknown>[] }
  const { client } = fakeDb(
    { person_roles: (opts.waiting ?? ['u1']).map((user_id) => ({ user_id, job_id: `j-${user_id}`, judged_at: null, hidden_reason: null })) },
    {
      rpc: {
        take_judge_call: (a) => {
          budget.args.push(a)
          const user = String(a.p_user)
          if (budget.used >= Number(a.p_cap) || (budget.mine[user] ?? 0) >= Number(a.p_share)) return false
          budget.used++
          budget.mine[user] = (budget.mine[user] ?? 0) + 1
          return true
        },
      },
    }
  )
  const call = vi.fn(async (_keys: unknown, req: { model?: string }) => {
    const r = opts.replies ? opts.replies(req.model) : answer(req.model ?? 'anthropic/claude-sonnet-5')
    if (r instanceof Error) throw r
    return r
  })
  const bucket = new Bucket(opts.perMinute ?? 20, 60_000, () => NOW.getTime())
  const deps = {
    call: call as never,
    loadKeys: async () => ({ userId: 'u1', ...(opts.keys ?? {}) }) as never,
    platformKey: () => ('platform' in opts ? opts.platform : 'sk-platform'),
    selfHosted: () => opts.selfHosted ?? false,
    bucket,
    now: () => NOW,
    dailyCap: () => opts.cap ?? 800,
    models: () => ['google/gemma-4-31b-it:free', 'some/paid-model', 'nvidia/nemotron-3-super-120b-a12b:free'],
    cooling: new Map<string, number>(),
  } satisfies DoorDeps
  const run = () => judgeCall(client, { userId: 'u1', step: 'role.evidence', prompt: 'sys', input: 'in', schema }, deps)
  return { run, call, budget, bucket, deps }
}

describe('the path order', () => {
  it('uses the person own key first, at R4, and spends none of the free budget', async () => {
    const t = setup({ keys: { openrouter: 'sk-own' } })
    const r = await t.run()
    expect(r).toMatchObject({ ok: true, json: { ok: true }, prov: { step: 'role.evidence', model: 'anthropic/claude-sonnet-5', rung: 'R4', evidence: [] } })
    expect((t.call.mock.calls[0][0] as { openrouter: string }).openrouter).toBe('sk-own')
    expect(t.budget.used).toBe(0)
  })

  it('without a key asks the free models in order, never a model that is not free, and records R3', async () => {
    const t = setup({ replies: (m) => (m?.startsWith('google') ? new Error('503') : answer(m!)) })
    const r = await t.run()
    expect(r).toMatchObject({ ok: true, prov: { model: 'nvidia/nemotron-3-super-120b-a12b:free', rung: 'R3' } })
    expect(t.call.mock.calls.map((c) => (c[1] as { model: string }).model)).toEqual(['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free'])
    expect((t.call.mock.calls[0][0] as { openrouter: string }).openrouter).toBe('sk-platform')
    expect(t.budget.used).toBe(1)
  })

  it('leaves a model that failed or answered out of shape alone for five minutes, then asks it again', async () => {
    const t = setup({ replies: (m) => (m?.startsWith('google') ? new Error('429') : m?.startsWith('nvidia') && t.call.mock.calls.length < 3 ? answer(m, '{"nope":1}') : answer(m!)) })
    expect(await t.run()).toEqual({ ok: false, limit: 'bad_answer' })
    expect(t.call).toHaveBeenCalledTimes(2)
    // both are cooling: nothing is asked, and the answer is to try again soon
    expect(await t.run()).toEqual({ ok: false, limit: 'minute' })
    expect(t.call).toHaveBeenCalledTimes(2)
    t.deps.cooling.clear()
    expect(await t.run()).toMatchObject({ ok: true, prov: { model: 'nvidia/nemotron-3-super-120b-a12b:free' } })
    expect(t.call).toHaveBeenCalledTimes(4)
  })

  it('falls back to the free models when the own key fails', async () => {
    const t = setup({ keys: { openrouter: 'sk-own' }, replies: (m) => (m ? answer(m) : new Error('401')) })
    expect(await t.run()).toMatchObject({ ok: true, prov: { rung: 'R3' } })
  })

  it('uses a local model only on a self-hosted server where the person chose one', async () => {
    const local = { provider: { active: 'local-server', localServerBaseUrl: 'http://localhost:11434/v1' } }
    const t = setup({ platform: undefined, selfHosted: true, keys: local, replies: () => answer('llama3') })
    expect(await t.run()).toMatchObject({ ok: true, prov: { model: 'llama3', rung: 'R2' } })
    expect(await setup({ platform: undefined, selfHosted: false, keys: local }).run()).toEqual({ ok: false, limit: 'no_model' })
    expect(await setup({ platform: undefined }).run()).toEqual({ ok: false, limit: 'no_model' })
  })

  it('answers bad_answer when no model returns the shape asked for', async () => {
    expect(await setup({ replies: (m) => answer(m!, '{"nope":1}') }).run()).toEqual({ ok: false, limit: 'bad_answer' })
    expect(await setup({ replies: (m) => answer(m!, 'not json') }).run()).toEqual({ ok: false, limit: 'bad_answer' })
  })
})

describe('the minute bucket', () => {
  it('lets 20 calls through, then refuses, and refills a call every three seconds', () => {
    let t = 0
    const b = new Bucket(20, 60_000, () => t)
    expect(Array.from({ length: 20 }, () => b.take()).every(Boolean)).toBe(true)
    expect(b.take()).toBe(false)
    t = 2_900
    expect(b.take()).toBe(false)
    t = 3_000
    expect(b.take()).toBe(true)
    expect(b.take()).toBe(false)
  })

  it('answers minute without calling a model or touching the day budget', async () => {
    const t = setup()
    for (let i = 0; i < 20; i++) t.bucket.take()
    expect(await t.run()).toEqual({ ok: false, limit: 'minute' })
    expect(t.call).not.toHaveBeenCalled()
    expect(t.budget.used).toBe(0)
  })
})

describe('the day share', () => {
  it('is the cap over the people waiting, at least 20', () => {
    expect(dayShare(800, 1)).toBe(800)
    expect(dayShare(800, 10)).toBe(80)
    expect(dayShare(800, 100)).toBe(20)
    expect(dayShare(800, 0)).toBe(800)
  })

  it('sends the share of the people with unjudged roles to the budget', async () => {
    const t = setup({ waiting: ['u1', 'u2', 'u2', 'u3', 'u4'] })
    await t.run()
    expect(t.budget.args[0]).toMatchObject({ p_user: 'u1', p_share: 200, p_cap: 800, p_day: '2026-10-22' })
  })

  it('answers day, without calling a model, once the person share is used', async () => {
    const t = setup({ cap: 800, perMinute: 100, waiting: Array.from({ length: 40 }, (_, i) => `p${i}`) })
    // 40 other people plus the asker: 800 / 41 = 19, held up to the 20 minimum
    for (let i = 0; i < 20; i++) expect((await t.run()).ok).toBe(true)
    const before = t.call.mock.calls.length
    expect(await t.run()).toEqual({ ok: false, limit: 'day' })
    expect(t.call.mock.calls.length).toBe(before)
  })

  it('answers day when the whole day cap is used', async () => {
    const t = setup({ cap: 2, perMinute: 100 })
    await t.run()
    await t.run()
    expect(await t.run()).toEqual({ ok: false, limit: 'day' })
  })
})
