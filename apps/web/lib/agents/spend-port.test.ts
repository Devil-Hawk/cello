// The agent's spend seam goes through the same ledger functions as every other model call.

import { describe, expect, it } from 'vitest'
import type { AdminClient } from '@/lib/harness/types'
import { BudgetCapError, isBudgetCapError, reserve, rootCause, settle } from './spend-port'

function fakeAdmin(reply: unknown = { ok: true, id: 'res-1' }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const updates: Record<string, unknown>[] = []
  const admin = {
    from: () => ({ update: (row: Record<string, unknown>) => ({ eq: async () => (updates.push(row), { error: null }) }) }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return { data: fn === 'reserve_llm_spend' ? reply : null, error: null }
    },
  } as unknown as AdminClient
  return { admin, calls, updates }
}

const base = { userId: 'u1', promptTokens: 1000, maxTokens: 2000 }

describe('reserve and settle', () => {
  it('a paid model reserves its worst case on the paid rung under the agent role step', async () => {
    const { admin, calls } = fakeAdmin()
    await reserve({ admin, model: 'anthropic/claude-sonnet-5', ...base })
    expect(calls[0].fn).toBe('reserve_llm_spend')
    expect(calls[0].args).toMatchObject({ p_user_id: 'u1', p_rung: 'R4', p_step: 'agent-chat' })
    expect(Number(calls[0].args.p_estimate)).toBeGreaterThan(0)
  })

  it('writes the role and the effort on the row, and a local model is not priced as a paid one', async () => {
    const { admin, calls, updates } = fakeAdmin()
    await reserve({ admin, model: 'llama3', role: 'researcher', effort: 'high', rung: 'R2', ...base })
    expect(calls[0].args).toMatchObject({ p_step: 'agent-researcher', p_rung: 'R2', p_estimate: 0 })
    expect(updates).toEqual([{ role: 'researcher', effort: 'high' }])
  })

  it('a free model reserves nothing, so a fallback works after the paid cap is reached', async () => {
    const { admin, calls } = fakeAdmin()
    await reserve({ admin, model: 'google/gemma-4-31b-it:free', ...base })
    expect(calls[0].args).toMatchObject({ p_rung: 'R3', p_estimate: 0 })
  })

  it('a reached cap is a BudgetCapError, however many layers wrapped it', async () => {
    const { admin } = fakeAdmin({ ok: false, scope: 'user', spent_usd: 5, cap_usd: 5 })
    const err = await reserve({ admin, model: 'anthropic/claude-sonnet-5', ...base }).catch((e) => e)
    expect(err).toBeInstanceOf(BudgetCapError)
    const wrapped = Object.assign(new Error('middleware failed'), { cause: err })
    expect(rootCause(wrapped)).toBe(err)
    expect(isBudgetCapError(wrapped)).toBe(true)
    expect(isBudgetCapError(new Error('other'))).toBe(false)
  })

  it('settles what the call cost, and a call that failed with a status settles at zero', async () => {
    const { admin, calls } = fakeAdmin()
    const reservation = await reserve({ admin, model: 'anthropic/claude-sonnet-5', ...base })
    await settle(reservation, { model: 'anthropic/claude-sonnet-5', promptTokens: 1000, completionTokens: 100 })
    expect(calls[1]).toMatchObject({ fn: 'settle_llm_spend', args: { p_id: 'res-1', p_status: null } })
    expect(Number(calls[1].args.p_actual)).toBeGreaterThan(0)

    await settle(reservation, { failed: Object.assign(new Error('rate limited'), { status: 429 }) })
    expect(calls[2].args).toMatchObject({ p_id: 'res-1', p_actual: 0, p_status: 429 })
  })
})
