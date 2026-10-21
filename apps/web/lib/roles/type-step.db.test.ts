// The typing step's two SQL functions against a REAL Postgres, in a transaction that is rolled back:
// a posting-led or ambiguous answer never freezes a key, each role is read once, a key gives a slice at most
// five roles, and a cached `none` expires when the taxonomy version changes.
//
//   CELLO_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     pnpm vitest run lib/roles/type-step.db.test.ts
//
// Needs migration 20261022000300 applied. Skipped when the variable is unset.

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { makePool, TEST_DB_URL } from '../test-support/db'

const AMBIGUOUS = ['member of technical staff']
const KEY = `zz-test-${randomUUID().slice(0, 8)}`

describe.skipIf(!TEST_DB_URL)('typing step functions (real database)', () => {
  let pool: Pool
  let db: PoolClient

  beforeAll(() => {
    pool = makePool()
  })
  afterAll(() => pool.end())
  beforeEach(async () => {
    db = await pool.connect()
    await db.query('begin')
  })
  afterEach(async () => {
    await db.query('rollback')
    db.release()
  })

  const title = (norm: string, dept: string, status: string, origin = 'code', version = 1) =>
    db.query(`insert into public.title_types (title_norm, dept_norm, origin, taxonomy_version, status, n_seen) values ($1, $2, $3, $4, $5, 1000000)`, [norm, dept, origin, version, status])
  const role = async (norm: string, dept: string) =>
    (await db.query(`insert into public.jobs (title, description, url, title_norm, dept_norm) values ($1, 'd', $2, $1, $3) returning id`, [norm, `https://example.test/${randomUUID()}`, dept])).rows[0].id as string
  const samples = (since: Date, version = 1, limit = 200) =>
    db.query(`select title_norm, dept_norm, job_id from public.pending_title_samples($1, $2, $3, 5, $4)`, [limit, version, since, AMBIGUOUS]).then((r) => r.rows.filter((x) => x.title_norm.startsWith('zz-test') || x.title_norm === 'member of technical staff'))
  const apply = (rows: unknown[]) => db.query(`select public.apply_model_titles($1::jsonb)`, [JSON.stringify(rows)])
  const jobRow = async (id: string) => (await db.query(`select role_type, type_origin, type_read_at from public.jobs where id = $1`, [id])).rows[0]
  const cacheRowOf = async (norm: string, dept = '') => (await db.query(`select status, role_type, origin, taxonomy_version from public.title_types where title_norm = $1 and dept_norm = $2`, [norm, dept])).rows[0]

  it('a posting-led answer types that role, marks it read, and leaves the key pending for the next role', async () => {
    await title(KEY, '', 'pending')
    const first = await role(KEY, '')
    const second = await role(KEY, '')
    const since = new Date()
    const got = await samples(since)
    expect(got).toHaveLength(1) // a title that names a job gives one role to a call
    await apply([{ title_norm: KEY, dept_norm: '', status: 'pending', taxonomy_version: 1, prov: {}, job_id: got[0].job_id, read_at: since.toISOString(), job_type: 'ai-engineer', job_prov: { step: 'role.type' } }])
    expect(await cacheRowOf(KEY)).toMatchObject({ status: 'pending', origin: 'code', role_type: null })
    const typed = await jobRow(got[0].job_id)
    expect(typed).toMatchObject({ role_type: 'ai-engineer', type_origin: 'model' })
    expect(typed.type_read_at).not.toBeNull()
    const next = await samples(since)
    expect(next.map((r) => r.job_id)).toEqual([[first, second].find((id) => id !== got[0].job_id)])
  })

  it('reads an ambiguous key role by role, each role once, five a slice', async () => {
    await title('member of technical staff', KEY, 'pending')
    const ids: string[] = []
    for (let i = 0; i < 8; i++) ids.push(await role('member of technical staff', KEY))
    const since = new Date(Date.now() - 1000)
    const firstFive = (await samples(since)).filter((r) => r.dept_norm === KEY)
    expect(firstFive).toHaveLength(5)
    await apply(firstFive.map((r) => ({ title_norm: r.title_norm, dept_norm: r.dept_norm, status: 'pending', taxonomy_version: 1, prov: {}, job_id: r.job_id, read_at: new Date().toISOString() })))
    // read and nothing decided it: the key is still pending, the roles are marked read, no role is typed
    expect((await cacheRowOf('member of technical staff', KEY)).status).toBe('pending')
    expect((await jobRow(firstFive[0].job_id)).role_type).toBeNull()
    // the same slice reads no more of this key; a later slice reads the other three and never the five again
    expect((await samples(since)).filter((r) => r.dept_norm === KEY)).toHaveLength(0)
    const later = (await samples(new Date(Date.now() + 60_000))).filter((r) => r.dept_norm === KEY)
    expect(later).toHaveLength(3)
    expect(new Set(later.map((r) => r.job_id))).toEqual(new Set(ids.filter((id) => !firstFive.some((f) => f.job_id === id))))
  })

  it('caches a none for a title that names a job, and asks again only when the taxonomy version changes', async () => {
    await title(KEY, '', 'pending')
    await role(KEY, '')
    await apply([{ title_norm: KEY, dept_norm: '', status: 'none', taxonomy_version: 1, prov: {} }])
    expect(await cacheRowOf(KEY)).toMatchObject({ status: 'none', origin: 'model', taxonomy_version: 1 })
    expect(await samples(new Date(), 1)).toEqual([])
    expect((await samples(new Date(), 2)).map((r) => r.title_norm)).toEqual([KEY])
    // a new version that types it replaces the none; the same version cannot
    await apply([{ title_norm: KEY, dept_norm: '', status: 'typed', role_type: 'ai-engineer', taxonomy_version: 1, prov: {} }])
    expect(await cacheRowOf(KEY)).toMatchObject({ status: 'none' })
    await apply([{ title_norm: KEY, dept_norm: '', status: 'typed', role_type: 'ai-engineer', taxonomy_version: 2, prov: {} }])
    expect(await cacheRowOf(KEY)).toMatchObject({ status: 'typed', role_type: 'ai-engineer', taxonomy_version: 2 })
  })

  it('serves a typed title to every untyped role with it', async () => {
    await title(KEY, '', 'pending')
    const a = await role(KEY, '')
    const b = await role(KEY, '')
    await apply([{ title_norm: KEY, dept_norm: '', status: 'typed', role_type: 'ai-engineer', taxonomy_version: 1, prov: {} }])
    expect(await jobRow(a)).toMatchObject({ role_type: 'ai-engineer', type_origin: 'model' })
    expect(await jobRow(b)).toMatchObject({ role_type: 'ai-engineer', type_origin: 'model' })
  })
})
