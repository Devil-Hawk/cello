// Real-database helpers for the *.db.test.ts files. They run only when
// CELLO_TEST_DB_URL points at a Postgres that already has the migrations applied
// (locally: postgresql://postgres:postgres@127.0.0.1:54322/postgres). Nothing
// here mocks the database: the tests exercise the actual SQL functions, grants
// and row locks.

import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { AdminClient } from '../harness/types'

export const TEST_DB_URL = process.env.CELLO_TEST_DB_URL

export function makePool(): Pool {
  return new Pool({ connectionString: TEST_DB_URL, max: 30 })
}

/** Run one statement as a client role, the way PostgREST does: switch role and
 *  set the JWT claims inside a transaction. */
export async function asRole<T = Record<string, unknown>>(
  pool: Pool,
  role: 'anon' | 'authenticated' | 'service_role',
  claims: Record<string, unknown>,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(`set local role ${role}`)
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    const res = await client.query(sql, params)
    await client.query('commit')
    return res.rows as T[]
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** A stand-in for the service-role Supabase client whose rpc() runs the real
 *  function as the service_role database role. Named arguments, like PostgREST. */
export function serviceRpc(pool: Pool): AdminClient {
  return {
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const keys = Object.keys(args)
      const call = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
      try {
        const rows = await asRole(pool, 'service_role', { role: 'service_role' }, `select public.${name}(${call}) as r`, keys.map((k) => args[k]))
        return { data: rows[0]?.r ?? null, error: null }
      } catch (err) {
        return { data: null, error: { message: (err as Error).message, code: (err as { code?: string }).code } }
      }
    },
  } as unknown as AdminClient
}

export interface TestUser {
  id: string
}

/** A throwaway auth user plus profile. `demo` marks it as a demo workspace. */
export async function createUser(
  pool: Pool,
  opts: { capUsd?: number; demo?: boolean } = {}
): Promise<TestUser> {
  const id = randomUUID()
  await pool.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `t-${id}@example.invalid`])
  await pool.query(`insert into public.profiles (id, email) values ($1, $2) on conflict (id) do nothing`, [id, `t-${id}@example.invalid`])
  if (opts.capUsd !== undefined) {
    await pool.query(
      `update public.profiles set preferences = jsonb_set(coalesce(preferences,'{}'::jsonb), '{budget}', jsonb_build_object('monthlyUsd', $2::numeric)) where id = $1`,
      [id, opts.capUsd]
    )
  }
  if (opts.demo) {
    await pool.query(`update public.profiles set is_demo = true, demo_expires_at = now() + interval '72 hours' where id = $1`, [id])
  }
  return { id }
}

export async function deleteUsers(pool: Pool, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await pool.query(`delete from public.access_code_events where code_id in (select id from public.access_codes where owner_user_id = any($1) or demo_user_id = any($1))`, [ids])
  await pool.query(`delete from public.access_codes where owner_user_id = any($1) or demo_user_id = any($1)`, [ids])
  await pool.query(`delete from public.llm_spend where user_id = any($1)`, [ids])
  await pool.query(`delete from public.profiles where id = any($1)`, [ids])
  await pool.query(`delete from auth.users where id = any($1)`, [ids])
}
