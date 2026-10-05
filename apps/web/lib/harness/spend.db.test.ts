// The spend ledger against a REAL Postgres: parallel reservations, settle,
// sweeper, month rollover, the shared demo allowance and the grants.
//
//   CELLO_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     pnpm vitest run lib/harness/spend.db.test.ts
//
// Needs migration 20261006002000 applied (psql -f is idempotent). Skipped when the
// variable is unset, so the default test run never needs a database.

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, createUser, deleteUsers, makePool, serviceRpc, TEST_DB_URL } from '../test-support/db'
import { BudgetCapError, getSpendState, reserveSpend, settleSpend } from './spend'

describe.skipIf(!TEST_DB_URL)('spend ledger (real database)', () => {
  let pool: Pool
  const users: string[] = []
  const admin = () => serviceRpc(pool)

  async function user(opts: Parameters<typeof createUser>[1] = {}) {
    const u = await createUser(pool, opts)
    users.push(u.id)
    return u.id
  }
  const reserve = (userId: string, estimate: number) =>
    asRole<{ r: { ok: boolean; id?: string; scope?: string } }>(
      pool,
      'service_role',
      { role: 'service_role' },
      'select public.reserve_llm_spend($1, $2, $3) as r',
      [userId, 'anthropic/claude-sonnet-5', estimate]
    ).then((rows) => rows[0].r)
  const sum = async (userId: string) =>
    Number((await pool.query(`select coalesce(sum(coalesce(actual_usd, estimate_usd)), 0) as s from public.llm_spend where user_id = $1`, [userId])).rows[0].s)

  beforeAll(() => {
    pool = makePool()
  })
  afterAll(async () => {
    await deleteUsers(pool, users)
    await pool.end()
  })

  it('25 parallel $0.10 reservations against a $1.00 cap admit exactly 10 and never pass the cap', async () => {
    const u = await user({ capUsd: 1 })
    const results = await Promise.all(Array.from({ length: 25 }, () => reserve(u, 0.1)))
    const admitted = results.filter((r) => r.ok)
    expect(admitted).toHaveLength(10)
    expect(results.filter((r) => !r.ok && r.scope === 'user')).toHaveLength(15)
    expect(await sum(u)).toBeCloseTo(1.0, 6)

    for (const r of admitted) {
      await asRole(pool, 'service_role', { role: 'service_role' }, 'select public.settle_llm_spend($1, $2)', [r.id, 0.1])
    }
    const state = await getSpendState(admin(), u)
    expect(state.spentUsd).toBeCloseTo(1.0, 6)
    expect(state.heldUsd).toBe(0)
    expect(state.spentUsd).toBeLessThanOrEqual(state.capUsd)
  })

  it('reserveSpend and settleSpend drive the same functions: BudgetCapError carries the figures', async () => {
    const u = await user({ capUsd: 0.05 })
    // 1000 prompt + 2048 max tokens on sonnet-5 is about $0.0225.
    const input = { userId: u, model: 'anthropic/claude-sonnet-5', promptTokens: 1000, maxTokens: 2048 }
    const a = await reserveSpend(admin(), input)
    const b = await reserveSpend(admin(), input)
    expect(a.id).toBeTruthy()
    await expect(reserveSpend(admin(), input)).rejects.toMatchObject({ name: 'BudgetCapError', scope: 'user', capUsd: 0.05 })
    // Settling at a lower real cost frees headroom for the next call.
    await settleSpend(admin(), a, { model: input.model, promptTokens: 100, completionTokens: 10, costUsd: 0.001 })
    await settleSpend(admin(), b, { failed: Object.assign(new Error('rate limited'), { status: 429 }) })
    await expect(reserveSpend(admin(), input)).resolves.toMatchObject({ id: expect.any(String) })
    const err = await reserveSpend(admin(), { ...input, maxTokens: 100_000 }).catch((e) => e)
    expect(err).toBeInstanceOf(BudgetCapError)
  })

  it('a double settle is a no-op: the first actual stays', async () => {
    const u = await user({ capUsd: 5 })
    const { id } = await reserve(u, 0.2)
    const settle = (n: number) =>
      asRole<{ r: boolean }>(pool, 'service_role', { role: 'service_role' }, 'select public.settle_llm_spend($1, $2) as r', [id, n]).then((r) => r[0].r)
    expect(await settle(0.05)).toBe(true)
    expect(await settle(0.09)).toBe(false)
    const row = (await pool.query(`select actual_usd, status from public.llm_spend where id = $1`, [id])).rows[0]
    expect(Number(row.actual_usd)).toBe(0.05)
    expect(row.status).toBe('settled')
  })

  it('the sweeper charges only reservations older than 15 minutes, at their estimate, and a late settle replaces it', async () => {
    const u = await user({ capUsd: 5 })
    const old = await reserve(u, 0.3)
    const fresh = await reserve(u, 0.2)
    await pool.query(`update public.llm_spend set created_at = now() - interval '20 minutes' where id = $1`, [old.id])
    await pool.query(`update public.llm_spend set created_at = now() - interval '5 minutes' where id = $1`, [fresh.id])
    const swept = await asRole<{ r: { expired: number } }>(pool, 'service_role', { role: 'service_role' }, 'select public.sweep_llm_spend() as r')
    expect(swept[0].r.expired).toBeGreaterThanOrEqual(1)
    const rows = (await pool.query(`select id, status, actual_usd from public.llm_spend where user_id = $1`, [u])).rows
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId[old.id!].status).toBe('expired')
    expect(Number(byId[old.id!].actual_usd)).toBe(0.3)
    expect(byId[fresh.id!].status).toBe('reserved')

    await asRole(pool, 'service_role', { role: 'service_role' }, 'select public.settle_llm_spend($1, $2)', [old.id, 0.04])
    const after = (await pool.query(`select status, actual_usd from public.llm_spend where id = $1`, [old.id])).rows[0]
    expect(after.status).toBe('settled')
    expect(Number(after.actual_usd)).toBe(0.04)
  })

  it('month rollover: last month is not charged against this month', async () => {
    const u = await user({ capUsd: 1 })
    await pool.query(
      `insert into public.llm_spend (user_id, period, model, estimate_usd, actual_usd, status)
       values ($1, (date_trunc('month', now() at time zone 'utc') - interval '1 month')::date, 'm', 0.99, 0.99, 'settled')`,
      [u]
    )
    expect((await reserve(u, 0.5)).ok).toBe(true)
    expect((await reserve(u, 0.6)).ok).toBe(false)
  })

  it('six demos of one owner share a $5 allowance: exactly five $0.90 reservations pass', async () => {
    const owner = await user({ capUsd: 100 })
    const demos = await Promise.all(Array.from({ length: 6 }, () => user({ capUsd: 1, demo: true })))
    for (const d of demos) {
      await pool.query(
        `insert into public.access_codes (owner_user_id, code_hash, code_prefix, expires_at, demo_user_id)
         values ($1, $2, 'TEST', now() + interval '1 hour', $3)`,
        [owner, `h1:${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`, d]
      )
    }
    const results = await Promise.all(demos.map((d) => reserve(d, 0.9)))
    expect(results.filter((r) => r.ok)).toHaveLength(5)
    const refused = results.filter((r) => !r.ok)
    expect(refused).toHaveLength(1)
    expect(refused[0].scope).toBe('demo-pool')
    // The owner's own spend is not drawn from the pool.
    expect((await reserve(owner, 20)).ok).toBe(true)
    const state = await asRole<{ r: { used_usd: number; cap_usd: number } }>(pool, 'service_role', { role: 'service_role' }, 'select public.demo_allowance_state($1) as r', [owner])
    expect(Number(state[0].r.used_usd)).toBeCloseTo(4.5, 6)
    expect(Number(state[0].r.cap_usd)).toBe(5)
  })

  it('a demo with no funding owner may not spend, and a free estimate is still admitted', async () => {
    const orphan = await user({ capUsd: 1, demo: true })
    const denied = await reserve(orphan, 0.01)
    expect(denied).toMatchObject({ ok: false, scope: 'demo-pool' })
    expect((await reserve(orphan, 0)).ok).toBe(true)
  })

  it('a zero estimate is admitted at the cap and a negative estimate raises', async () => {
    const u = await user({ capUsd: 1 })
    expect((await reserve(u, 1)).ok).toBe(true)
    expect((await reserve(u, 0.01)).ok).toBe(false)
    expect((await reserve(u, 0)).ok).toBe(true)
    await expect(reserve(u, -1)).rejects.toThrow(/at least zero/)
  })

  it('a free model reserves nothing and never touches the database', async () => {
    const u = await user({ capUsd: 1 })
    const before = (await pool.query(`select count(*)::int as n from public.llm_spend where user_id = $1`, [u])).rows[0].n
    const res = await reserveSpend(admin(), { userId: u, model: 'google/gemma-4-31b-it:free', promptTokens: 9_000_000, maxTokens: 9_000_000 })
    expect(res.id).toBeNull()
    const after = (await pool.query(`select count(*)::int as n from public.llm_spend where user_id = $1`, [u])).rows[0].n
    expect(after).toBe(before)
  })

  it('signed-in users can read their own ledger but write nothing, and cannot call the functions; anon sees nothing', async () => {
    const a = await user({ capUsd: 5 })
    const b = await user({ capUsd: 5 })
    await reserve(a, 0.1)
    await reserve(b, 0.1)
    const claims = (id: string) => ({ sub: id, role: 'authenticated' })
    const rows = await asRole<{ user_id: string }>(pool, 'authenticated', claims(a), 'select user_id from public.llm_spend')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.user_id === a)).toBe(true)

    await expect(
      asRole(pool, 'authenticated', claims(a), `insert into public.llm_spend (user_id, period, model, estimate_usd) values ($1, now(), 'm', 0)`, [a])
    ).rejects.toThrow(/permission denied/)
    await expect(asRole(pool, 'authenticated', claims(a), `update public.llm_spend set actual_usd = 0`)).rejects.toThrow(/permission denied/)
    await expect(asRole(pool, 'authenticated', claims(a), `delete from public.llm_spend`)).rejects.toThrow(/permission denied/)
    for (const call of [
      `select public.reserve_llm_spend($1, 'm', 0.1)`,
      `select public.settle_llm_spend(gen_random_uuid(), 0)`,
      `select public.llm_spend_state($1)`,
      `select public.sweep_llm_spend()`,
    ]) {
      await expect(asRole(pool, 'authenticated', claims(a), call, call.includes('$1') ? [a] : [])).rejects.toThrow(/permission denied/)
    }
    await expect(asRole(pool, 'anon', { role: 'anon' }, 'select * from public.llm_spend')).rejects.toThrow(/permission denied/)
  })

  it('resetting the old preferences counters over the Data API no longer frees any allowance', async () => {
    const u = await user({ capUsd: 1 })
    expect((await reserve(u, 1)).ok).toBe(true)
    // The hole this closes: a signed-in user could always write this.
    await asRole(
      pool,
      'authenticated',
      { sub: u, role: 'authenticated' },
      `update public.profiles set preferences = jsonb_set(preferences, '{budget,spentUsd}', '0') where id = $1`,
      [u]
    )
    expect((await reserve(u, 0.5)).ok).toBe(false)
  })

  it('a missing profile is refused rather than spending for nobody', async () => {
    expect(await reserve(randomUUID(), 0.1).catch((e) => ({ ok: false, err: String(e) }))).toMatchObject({ ok: false })
  })
})
