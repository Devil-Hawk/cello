// Race cases for run.sh. Needs RACE_DIRECT_URL (Postgres) and RACE_POOLER_URL
// (a transaction pooler in front of it, as in production on port 6543).
// Each case throws on failure. Later packages add cases to the array below.
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
const pg = require('pg')

const DIRECT = process.env.RACE_DIRECT_URL
const POOLER = process.env.RACE_POOLER_URL
if (!DIRECT || !POOLER) throw new Error('set RACE_DIRECT_URL and RACE_POOLER_URL')

const clients = []

async function connect(url, n) {
  const made = await Promise.all(
    Array.from({ length: n }, async () => {
      const c = new pg.Client({ connectionString: url })
      await c.connect()
      clients.push(c)
      return c
    }),
  )
  return made
}

// The pooler container may still be starting.
async function waitFor(url) {
  for (let i = 0; i < 30; i++) {
    const c = new pg.Client({ connectionString: url })
    try {
      await c.connect()
      await c.query('select 1')
      await c.end()
      return
    } catch {
      await c.end().catch(() => {})
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error('pooler did not accept connections')
}

const same = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

const resetLease = (db) =>
  db.query('update race.lease set lease_holder = null, lease_until = null where id = 1')

const cases = [
  {
    name: 'a session lock through the pooler admits a second holder',
    run: async () => {
      // Two clients on the pooler share one server session, so both "hold" lock 42.
      const [a, b] = await connect(POOLER, 2)
      const got = async (c, key) =>
        (await c.query('select pg_try_advisory_lock($1) as ok', [key])).rows[0].ok
      same(await got(a, 42), true, 'pooler client 1')
      same(await got(b, 42), true, 'pooler client 2 (the break)')
      // Direct, the second client is refused (another key: the pooler still holds 42). This also proves POOLER really pools.
      const [c, d] = await connect(DIRECT, 2)
      same(await got(c, 43), true, 'direct client 1')
      same(await got(d, 43), false, 'direct client 2')
    },
  },
  {
    name: 'a lease claim through the pooler: read then write races, one conditional update does not',
    run: async ({ direct }) => {
      const claimers = await connect(POOLER, 10)

      await resetLease(direct)
      const winners = await Promise.all(
        claimers.map(async (c) => {
          await c.query('begin')
          const { rows } = await c.query(
            'select 1 from race.lease where id = 1 and (lease_until is null or lease_until < now())',
          )
          await c.query('select pg_sleep(0.2)')
          if (rows.length) {
            await c.query(
              "update race.lease set lease_holder = $1, lease_until = now() + interval '30 seconds' where id = 1",
              [randomUUID()],
            )
          }
          await c.query('commit')
          return rows.length
        }),
      )
      const claimed = winners.reduce((n, w) => n + w, 0)
      if (claimed < 2) throw new Error(`read then write gave ${claimed} winner, the race did not reproduce`)

      await resetLease(direct)
      const holders = claimers.map(() => randomUUID())
      const results = await Promise.all(
        claimers.map((c, i) =>
          c.query(
            `update race.lease set lease_holder = $1, lease_until = now() + interval '30 seconds'
             where id = 1 and (lease_until is null or lease_until < now())
             returning lease_holder`,
            [holders[i]],
          ),
        ),
      )
      const won = results.filter((r) => r.rowCount === 1)
      same(won.length, 1, 'conditional update winners')
      const { rows } = await direct.query('select lease_holder from race.lease where id = 1')
      same(rows[0].lease_holder, won[0].rows[0].lease_holder, 'stored holder')
    },
  },
]

let failed = 0
try {
  await waitFor(POOLER)
  const [direct] = await connect(DIRECT, 1)
  await direct.query(`
    create schema if not exists race;
    create table if not exists race.lease (id int primary key, lease_holder uuid, lease_until timestamptz);
    insert into race.lease values (1, null, null) on conflict do nothing`)
  for (const c of cases) {
    try {
      await c.run({ direct })
      console.log(`ok   race: ${c.name}`)
    } catch (e) {
      failed++
      console.log(`FAIL race: ${c.name}: ${e.message}`)
    }
  }
} catch (e) {
  failed++
  console.log(`FAIL race setup: ${e.message}`)
} finally {
  await Promise.all(clients.map((c) => c.end().catch(() => {})))
}
process.exitCode = failed ? 1 : 0
