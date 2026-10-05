// Access-code redemption, limits, minting and revocation against a REAL Postgres.
//
//   CELLO_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     pnpm vitest run lib/access/access-codes.db.test.ts
//
// Needs migrations 20261006002000 and 20261006002001 applied. Skipped when the
// variable is unset.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole, createUser, deleteUsers, makePool, TEST_DB_URL } from '../test-support/db'

const hash = () => `h1:${randomBytes(32).toString('hex')}`
const SERVICE = { role: 'service_role' }

describe.skipIf(!TEST_DB_URL)('access codes (real database)', () => {
  let pool: Pool
  const users: string[] = []

  const rpc = <T>(sql: string, params: unknown[] = []) =>
    asRole<{ r: T }>(pool, 'service_role', SERVICE, sql, params).then((rows) => rows[0]?.r)
  const user = async (opts: Parameters<typeof createUser>[1] = {}) => {
    const u = await createUser(pool, opts)
    users.push(u.id)
    return u.id
  }
  const mint = async (owner: string, h = hash(), expires = `now() + interval '72 hours'`) => {
    const rows = await asRole<{ id: string; code_hash: string; expires_at: string }>(
      pool,
      'service_role',
      SERVICE,
      `select * from public.mint_access_code($1, $2, 'ABCD', null, ${expires})`,
      [owner, h]
    )
    return rows[0]
  }
  const redeem = (...hashes: string[]) =>
    rpc<{ status: string; code_id?: string; reason?: string; demo_user_id?: string }>('select public.redeem_access_code($1) as r', [hashes])
  const count = async (id: string) =>
    Number((await pool.query(`select redemption_count from public.access_codes where id = $1`, [id])).rows[0].redemption_count)

  beforeAll(async () => {
    pool = makePool()
    await pool.query(`delete from public.access_redeem_attempts`)
  })
  afterAll(async () => {
    await pool.query(`delete from public.access_redeem_attempts`)
    await deleteUsers(pool, users)
    await pool.end()
  })

  describe('the redemption limiter', () => {
    const note = (key: string) => rpc<boolean>('select public.note_redeem_attempt($1) as r', [key])

    it('13 sequential attempts with one key: the 13th is refused', async () => {
      const key = randomBytes(16).toString('hex')
      const results: boolean[] = []
      for (let i = 0; i < 13; i++) results.push(await note(key))
      expect(results.slice(0, 12).every(Boolean)).toBe(true)
      expect(results[12]).toBe(false)
    })

    it('20 parallel attempts with one key admit exactly 12', async () => {
      const key = randomBytes(16).toString('hex')
      const results = await Promise.all(Array.from({ length: 20 }, () => note(key)))
      expect(results.filter(Boolean)).toHaveLength(12)
    })

    it('the global bucket caps distinct keys at 240 a window', async () => {
      await pool.query(`delete from public.access_redeem_attempts`)
      const results: boolean[] = []
      for (let i = 0; i < 241; i++) results.push(await note(randomBytes(16).toString('hex')))
      expect(results.slice(0, 240).every(Boolean)).toBe(true)
      expect(results[240]).toBe(false)
      await pool.query(`delete from public.access_redeem_attempts`)
    })

    it('pruning removes a window older than an hour and keeps the current one', async () => {
      await pool.query(`insert into public.access_redeem_attempts values ('c:old', now() - interval '2 hours', 3)`)
      await note(randomBytes(16).toString('hex'))
      expect(await rpc<number>('select public.prune_redeem_attempts() as r')).toBeGreaterThanOrEqual(1)
      const left = await pool.query(`select count(*)::int as n from public.access_redeem_attempts where bucket = 'c:old'`)
      expect(left.rows[0].n).toBe(0)
      expect((await pool.query(`select count(*)::int as n from public.access_redeem_attempts`)).rows[0].n).toBeGreaterThan(0)
    })

    it('stores no raw address: a key that is not a short token is refused', async () => {
      await expect(note('')).rejects.toThrow(/client key/)
    })
  })

  describe('atomic redemption', () => {
    it('10 parallel redemptions of a fresh code: exactly one provisions, nine are told to retry', async () => {
      const owner = await user({ capUsd: 10 })
      const code = await mint(owner)
      const results = await Promise.all(Array.from({ length: 10 }, () => redeem(code.code_hash)))
      expect(results.filter((r) => r.status === 'provision')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'busy')).toHaveLength(9)
      expect(await count(code.id)).toBe(0)

      // The provisioner finishes: the demo is recorded and counted once.
      const demo = await user({ demo: true })
      expect(await rpc<boolean>('select public.finish_access_code_provisioning($1, $2) as r', [code.id, demo])).toBe(true)
      expect(await count(code.id)).toBe(1)

      const after = await Promise.all(Array.from({ length: 10 }, () => redeem(code.code_hash)))
      expect(after.every((r) => r.status === 'existing' && r.demo_user_id === demo)).toBe(true)
      expect(await count(code.id)).toBe(11)
    })

    it('redemptions queued behind a held row lock still yield exactly one provisioner', async () => {
      // Hold the code row so every redemption has already started when the lock
      // is released. Without the function's own `for update` they would all read
      // the unprovisioned row first and all be told to provision.
      const owner = await user({ capUsd: 10 })
      const code = await mint(owner)
      const holder = await pool.connect()
      try {
        await holder.query('begin')
        await holder.query(`select 1 from public.access_codes where id = $1 for update`, [code.id])
        const pending = Array.from({ length: 10 }, () => redeem(code.code_hash))
        await new Promise((r) => setTimeout(r, 400))
        await holder.query('commit')
        const results = await Promise.all(pending)
        expect(results.filter((r) => r.status === 'provision')).toHaveLength(1)
        expect(results.filter((r) => r.status === 'busy')).toHaveLength(9)
      } finally {
        holder.release()
      }
    })

    it('a lapsed lease lets another request provision, and finish is idempotent for the same demo', async () => {
      const owner = await user({ capUsd: 10 })
      const code = await mint(owner)
      expect((await redeem(code.code_hash)).status).toBe('provision')
      expect((await redeem(code.code_hash)).status).toBe('busy')
      await pool.query(`update public.access_codes set provisioning_until = now() - interval '1 second' where id = $1`, [code.id])
      expect((await redeem(code.code_hash)).status).toBe('provision')

      const demo = await user({ demo: true })
      const other = await user({ demo: true })
      expect(await rpc<boolean>('select public.finish_access_code_provisioning($1, $2) as r', [code.id, demo])).toBe(true)
      expect(await rpc<boolean>('select public.finish_access_code_provisioning($1, $2) as r', [code.id, demo])).toBe(true)
      expect(await rpc<boolean>('select public.finish_access_code_provisioning($1, $2) as r', [code.id, other])).toBe(false)
      expect(await count(code.id)).toBe(1)
    })

    it('unknown, expired, revoked and used codes are all refused with the same status', async () => {
      const owner = await user({ capUsd: 10 })

      const unknown = await redeem(hash())

      const expired = await mint(owner)
      await pool.query(
        `update public.access_codes set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1`,
        [expired.id]
      )
      const revoked = await mint(owner)
      await rpc('select public.revoke_access_code($1, $2) as r', [revoked.id, owner])

      const used = await mint(owner)
      const demo = await user({ demo: true })
      await redeem(used.code_hash)
      await rpc('select public.finish_access_code_provisioning($1, $2) as r', [used.id, demo])
      // The workspace is deleted: the FK nulls demo_user_id, the code row stays.
      await pool.query(`delete from public.profiles where id = $1`, [demo])
      await pool.query(`delete from auth.users where id = $1`, [demo])

      const results = [unknown, await redeem(expired.code_hash), await redeem(revoked.code_hash), await redeem(used.code_hash)]
      expect(results.map((r) => r.status)).toEqual(['refused', 'refused', 'refused', 'refused'])
      expect(results.map((r) => r.reason)).toEqual([undefined, 'expired', 'revoked', 'used'])
      // A deleted workspace does not mint a fresh demo for the same code.
      expect(results[3].status).not.toBe('provision')
    })

    it('a legacy SHA-256 row is redeemable through the second hash', async () => {
      const owner = await user({ capUsd: 10 })
      const plaintext = 'LEGACYCODE12'
      const legacy = createHash('sha256').update(plaintext).digest('hex')
      await pool.query(
        `insert into public.access_codes (owner_user_id, code_hash, code_prefix, expires_at) values ($1, $2, 'LEGA', now() + interval '1 hour')`,
        [owner, legacy]
      )
      const res = await redeem(hash(), legacy)
      expect(res.status).toBe('provision')
    })

    it('finish refuses a code that was revoked while provisioning', async () => {
      const owner = await user({ capUsd: 10 })
      const code = await mint(owner)
      await redeem(code.code_hash)
      await rpc('select public.revoke_access_code($1, $2) as r', [code.id, owner])
      const demo = await user({ demo: true })
      expect(await rpc<boolean>('select public.finish_access_code_provisioning($1, $2) as r', [code.id, demo])).toBe(false)
    })
  })

  describe('minting', () => {
    it('refuses a bare SHA-256 hash, a demo owner and an unknown owner', async () => {
      const owner = await user({ capUsd: 10 })
      const bare = createHash('sha256').update('x').digest('hex')
      await expect(mint(owner, bare)).rejects.toMatchObject({ code: '22023' })

      const demoOwner = await user({ demo: true })
      await expect(mint(demoOwner)).rejects.toMatchObject({ code: '42501' })
      await expect(mint(randomUUID())).rejects.toMatchObject({ code: '42501' })
    })

    it('clamps expiry to 72 hours and refuses a past expiry', async () => {
      const owner = await user({ capUsd: 10 })
      const code = await mint(owner, hash(), `now() + interval '2000 hours'`)
      const hours = (new Date(code.expires_at).getTime() - Date.now()) / 3_600_000
      expect(hours).toBeLessThanOrEqual(72)
      expect(hours).toBeGreaterThan(71)
      await expect(mint(owner, hash(), `now() - interval '1 hour'`)).rejects.toMatchObject({ code: '22023' })
    })

    it('the 26th live code is refused, even when minted in parallel', async () => {
      const owner = await user({ capUsd: 10 })
      const results = await Promise.allSettled(Array.from({ length: 30 }, () => mint(owner)))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(25)
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(refused).toHaveLength(5)
      expect(refused.every((r) => (r.reason as { code?: string }).code === '23514')).toBe(true)
    })

    it('signed-in users cannot write access_codes over the Data API, but can read their own', async () => {
      const owner = await user({ capUsd: 10 })
      const other = await user({ capUsd: 10 })
      const code = await mint(owner)
      const claims = (id: string) => ({ sub: id, role: 'authenticated' })

      await expect(
        asRole(pool, 'authenticated', claims(owner), `insert into public.access_codes (owner_user_id, code_hash, code_prefix, expires_at) values ($1, $2, 'X', now() + interval '1 hour')`, [owner, hash()])
      ).rejects.toThrow(/permission denied/)
      await expect(
        asRole(pool, 'authenticated', claims(owner), `update public.access_codes set expires_at = now() + interval '9999 hours' where id = $1`, [code.id])
      ).rejects.toThrow(/permission denied/)
      await expect(
        asRole(pool, 'authenticated', claims(owner), `update public.access_codes set revoked_at = now() where id = $1`, [code.id])
      ).rejects.toThrow(/permission denied/)

      expect(await asRole(pool, 'authenticated', claims(owner), `select id from public.access_codes where id = $1`, [code.id])).toHaveLength(1)
      expect(await asRole(pool, 'authenticated', claims(other), `select id from public.access_codes where id = $1`, [code.id])).toHaveLength(0)
    })

    it('the functions cannot be called by a signed-in user or anon', async () => {
      const owner = await user({ capUsd: 10 })
      const claims = { sub: owner, role: 'authenticated' }
      for (const sql of [
        `select public.redeem_access_code(array['x'])`,
        `select public.note_redeem_attempt('x')`,
        `select public.revoke_access_code(gen_random_uuid(), '${owner}')`,
        `select public.finish_access_code_provisioning(gen_random_uuid(), gen_random_uuid())`,
      ]) {
        await expect(asRole(pool, 'authenticated', claims, sql)).rejects.toThrow(/permission denied/)
        await expect(asRole(pool, 'anon', { role: 'anon' }, sql)).rejects.toThrow(/permission denied/)
      }
    })
  })

  describe('revocation', () => {
    it('ends the demo session at once, and a second call or another owner changes nothing', async () => {
      const owner = await user({ capUsd: 10 })
      const stranger = await user({ capUsd: 10 })
      const code = await mint(owner)
      const demo = await user({ demo: true })
      await redeem(code.code_hash)
      await rpc('select public.finish_access_code_provisioning($1, $2) as r', [code.id, demo])

      // Another owner: nothing learned, nothing changed.
      const foreign = await rpc<{ found: boolean; revoked: boolean }>('select public.revoke_access_code($1, $2) as r', [code.id, stranger])
      expect(foreign).toMatchObject({ found: false, revoked: false })
      expect((await pool.query(`select revoked_at from public.access_codes where id = $1`, [code.id])).rows[0].revoked_at).toBeNull()

      const first = await rpc<{ found: boolean; revoked: boolean; demo_user_id: string }>('select public.revoke_access_code($1, $2) as r', [code.id, owner])
      expect(first).toMatchObject({ found: true, revoked: true, demo_user_id: demo })
      const row = (await pool.query(`select revoked_at from public.access_codes where id = $1`, [code.id])).rows[0]
      const prof = (await pool.query(`select demo_expires_at <= now() as ended from public.profiles where id = $1`, [demo])).rows[0]
      expect(row.revoked_at).not.toBeNull()
      expect(prof.ended).toBe(true)

      const second = await rpc<{ found: boolean; revoked: boolean; demo_user_id: string }>('select public.revoke_access_code($1, $2) as r', [code.id, owner])
      expect(second).toMatchObject({ found: true, revoked: false, demo_user_id: demo })
      const again = (await pool.query(`select revoked_at from public.access_codes where id = $1`, [code.id])).rows[0]
      expect(again.revoked_at.getTime()).toBe(row.revoked_at.getTime())
    })

    it('never expires a non-demo profile', async () => {
      const owner = await user({ capUsd: 10 })
      const code = await mint(owner)
      // A code that (wrongly) points at the owner's own non-demo profile.
      await pool.query(`update public.access_codes set demo_user_id = $2 where id = $1`, [code.id, owner])
      await rpc('select public.revoke_access_code($1, $2) as r', [code.id, owner])
      expect((await pool.query(`select demo_expires_at from public.profiles where id = $1`, [owner])).rows[0].demo_expires_at).toBeNull()
    })
  })
})
