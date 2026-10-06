// A live check that the free-model path and the provider-cost path behave end to
// end. Opt-in, because it makes one real request to a ':free' OpenRouter model
// (never a paid one) and needs a database:
//
//   set -a; source apps/web/.env.development.local; source ~/.cello-secrets.env; set +a
//   SPEND_SMOKE=1 CELLO_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     pnpm vitest run lib/harness/spend.smoke.test.ts
//
// Pass bar (both must hold):
//   1. a callLlm on a ':free' model returns text and writes one $0 R3 ledger row
//      per attempt (the reservation has a row id and an estimate of 0);
//   2. a recorded-shape paid response (fixtures/openrouter-usage.json, usage.cost
//      0.00042) settles a real reservation at exactly that cost.
// The key is read from OPENROUTER_API_KEY and is never printed.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUser, deleteUsers, makePool, serviceRpc } from '../test-support/db'
import { callLlm } from './llm'
import { actualCostUsd, reserveSpend, settleSpend } from './spend'

const run = process.env.SPEND_SMOKE === '1' && Boolean(process.env.CELLO_TEST_DB_URL) && Boolean(process.env.OPENROUTER_API_KEY)

describe.skipIf(!run)('spend smoke (one free-model call)', () => {
  let pool: Pool
  const users: string[] = []
  beforeAll(() => {
    pool = makePool()
  })
  afterAll(async () => {
    await deleteUsers(pool, users)
    await pool.end()
  })

  const ledgerRows = async (userId: string) =>
    Number((await pool.query(`select count(*)::int as n from public.llm_spend where user_id = $1`, [userId])).rows[0].n)

  async function freeModel(): Promise<string> {
    const res = await fetch('https://openrouter.ai/api/v1/models')
    const body = (await res.json()) as { data: Array<{ id: string }> }
    const free = body.data.map((m) => m.id).filter((id) => id.endsWith(':free'))
    // Prefer a small instruct model; any ':free' id proves the path.
    return free.find((id) => /gemma|llama|qwen/i.test(id)) ?? free[0]
  }

  it('a free-model call returns text and writes one $0 R3 row', async () => {
    const u = await createUser(pool, { capUsd: 1 })
    users.push(u.id)
    const model = await freeModel()
    expect(model.endsWith(':free')).toBe(true)

    try {
      const result = await callLlm(
        { openrouter: process.env.OPENROUTER_API_KEY, userId: u.id, isDemo: false },
        { model, prompt: 'Reply with the single word: ok', maxTokens: 20 }
      )
      expect(result.content.length).toBeGreaterThan(0)
    } catch (err) {
      // OpenRouter's free tier has a daily cap shared by everything on the key.
      // A 429 still proves the point below (a free call, answered or refused,
      // writes a $0 row), but it is not a pass of the "returns text" half.
      if ((err as { status?: number }).status !== 429) throw err
      console.warn('[spend smoke] free-model daily quota exhausted (429); text half not exercised')
    }
    // One row per attempt: a refused attempt that was retried writes more than one.
    expect(await ledgerRows(u.id)).toBeGreaterThanOrEqual(1)
    const rows = (await pool.query(`select rung, estimate_usd, actual_usd, step from public.llm_spend where user_id = $1`, [u.id])).rows
    for (const row of rows) {
      expect(row.rung).toBe('R3')
      expect(Number(row.estimate_usd)).toBe(0)
      expect(Number(row.actual_usd ?? 0)).toBe(0)
      expect(row.step).toBe('call-llm')
    }

    const before = await ledgerRows(u.id)
    const reservation = await reserveSpend(serviceRpc(pool), {
      userId: u.id,
      model,
      promptTokens: 9_999_999,
      maxTokens: 9_999_999,
      rung: 'R3',
      step: 'smoke',
    })
    expect(reservation.id).toBeTruthy()
    expect(reservation.estimateUsd).toBe(0)
    expect(await ledgerRows(u.id)).toBe(before + 1)
  }, 60_000)

  it('a paid-shape response settles a real reservation at the provider-reported cost', async () => {
    const u = await createUser(pool, { capUsd: 1 })
    users.push(u.id)
    const fixture = JSON.parse(readFileSync(path.join(__dirname, 'providers/fixtures/openrouter-usage.json'), 'utf8')) as {
      model: string
      usage: { prompt_tokens: number; completion_tokens: number }
    }
    const cost = actualCostUsd(fixture.usage)
    expect(cost).toBe(0.00042)

    const admin = serviceRpc(pool)
    const reservation = await reserveSpend(admin, { userId: u.id, model: fixture.model, promptTokens: 400, maxTokens: 2048, rung: 'R4', step: 'smoke' })
    expect(reservation.id).toBeTruthy()
    await settleSpend(admin, reservation, {
      model: fixture.model,
      promptTokens: fixture.usage.prompt_tokens,
      completionTokens: fixture.usage.completion_tokens,
      costUsd: cost,
    })
    const row = (await pool.query(`select status, actual_usd, estimate_usd from public.llm_spend where id = $1`, [reservation.id])).rows[0]
    expect(row.status).toBe('settled')
    expect(Number(row.actual_usd)).toBe(0.00042)
    expect(Number(row.estimate_usd)).toBeGreaterThan(Number(row.actual_usd))
  })
})
