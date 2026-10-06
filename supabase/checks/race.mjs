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

// ---------------------------------------------------------------------------
// K13: the pipeline's races, through the pooler. Every move is one statement, so each runs in its own
// transaction on whichever server session the pooler hands out; the per-person transaction lock is the
// only thing that can order them.
// ---------------------------------------------------------------------------

const TRANSITION = 'select public.pipeline_transition($1::uuid, $2::text[], $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb) as r'

const ev = (kind, actor, key, extra = {}) => ({ kind, actor, sentence: 'A line for the person.', idempotency_key: key, ...extra })

async function move(c, app, from, to, e, cap = null, reason = null, detail = null) {
  const { rows } = await c.query(TRANSITION, [
    app, from, to, 'Working', reason, detail && JSON.stringify(detail), JSON.stringify(e), cap && JSON.stringify(cap),
  ])
  return rows[0].r
}

async function mkPerson(db, { send = false, maxPerDay = 3 } = {}) {
  const u = randomUUID()
  const co = randomUUID()
  const tok = randomUUID()
  await db.query('insert into auth.users (id, email) values ($1, $2)', [u, `race-${u}@example.invalid`])
  await db.query("insert into public.companies (id, user_id, name, career_url) values ($1, $2, 'Race Co', 'https://race.example')", [co, u])
  await db.query('select public.companies_follow(array[$1::uuid], true, $2::uuid)', [co, u])
  if (send) {
    await db.query(
      "insert into public.api_tokens (id, user_id, name, token_hash, scopes, last_used_at) values ($1, $2, 'race', $3, array['fill:extension'], now())",
      [tok, u, `hash-${tok}`],
    )
    await db.query(
      "update public.profiles set preferences = coalesce(preferences, '{}'::jsonb) || jsonb_build_object('pipeline', jsonb_build_object('send', jsonb_build_object('mode', 'auto', 'maxPerDay', $3::int, 'tokenId', $2::text))) where id = $1",
      [u, tok, maxPerDay],
    )
  }
  return { u, co, tok }
}

async function mkApp(db, p, n) {
  const j = randomUUID()
  await db.query(
    "insert into public.jobs (id, company_id, title, description, url, external_id) values ($1, $2, $3, 'd', $4, $5)",
    [j, p.co, `Engineer ${n}`, `https://race.example/jobs/${p.u}/${n}`, `race-${n}-${j}`],
  )
  const { rows } = await db.query('insert into public.applications (user_id, job_id) values ($1, $2) returning id', [p.u, j])
  return { id: rows[0].id, job: j }
}

// A ready application Send for me may claim: chosen by the person, Strong, at a followed company.
async function mkAllowed(db, p, n) {
  // a throwaway database: scoring's column, if the migrations have not added it
  await db.query('alter table public.person_roles add column if not exists chance text')
  const a = await mkApp(db, p, n)
  await db.query(
    "insert into public.person_roles (user_id, job_id, chance) values ($1, $2, 'strong') on conflict (user_id, job_id) do update set chance = 'strong'",
    [p.u, a.job],
  )
  const started = await move(db, a.id, ['none'], 'preparing', ev('application.created', 'person', `race-s:${a.id}`))
  if (!started.ok) throw new Error(`setup start: ${JSON.stringify(started)}`)
  const ready = await move(db, a.id, ['preparing'], 'ready', ev('step.finished', 'schedule', `race-r:${a.id}`))
  if (!ready.ok) throw new Error(`setup ready: ${JSON.stringify(ready)}`)
  return a.id
}

const claimBody = (p, id, extra = {}) =>
  ev('fill.auto_started', 'extension', `race-claim:${id}`, { payload: { token_id: p.tok, auto: true, files: [{ name: 'resume.pdf', sha256: 'aa' }], ...extra } })

const drop = (db, p) => db.query('delete from auth.users where id = $1', [p.u])

const pausedAt = async (db, p) =>
  (await db.query("select (preferences -> 'pipeline' ->> 'paused_at')::timestamptz as t from public.profiles where id = $1", [p.u])).rows[0].t

const pipelineCases = [
  {
    name: 'ten starts under a cap of 3 let exactly three through',
    run: async ({ direct }) => {
      const p = await mkPerson(direct)
      const apps = []
      for (let i = 0; i < 10; i++) apps.push(await mkApp(direct, p, i))
      const cs = await connect(POOLER, 10)
      const rs = await Promise.all(
        cs.map((c, i) =>
          move(c, apps[i].id, ['none'], 'preparing', ev('application.created', 'rule', `race-cap:${apps[i].id}`), { kind: 'application.created', actor: 'rule', max: 3 }),
        ),
      )
      same(rs.filter((r) => r.ok).length, 3, 'starts let through')
      same(rs.filter((r) => r.refusal === 'cap').length, 7, 'starts refused for the cap')
      await drop(direct, p)
    },
  },
  {
    name: 'Pause racing five starts leaves no start after paused_at',
    run: async ({ direct }) => {
      const p = await mkPerson(direct)
      const apps = []
      for (let i = 0; i < 5; i++) apps.push(await mkApp(direct, p, i))
      const cs = await connect(POOLER, 6)
      const rs = await Promise.all([
        ...apps.map((a, i) => move(cs[i], a.id, ['none'], 'preparing', ev('application.created', 'person', `race-pz:${a.id}`))),
        cs[5].query('select public.pipeline_pause($1::uuid)', [p.u]),
      ])
      const t = await pausedAt(direct, p)
      if (!t) throw new Error('the pause did not land')
      const { rows } = await direct.query(
        "select count(*)::int as n from public.pipeline_events where user_id = $1 and kind = 'application.created' and created_at > $2",
        [p.u, t],
      )
      same(rows[0].n, 0, 'starts written after paused_at')
      const refused = rs.slice(0, 5).filter((r) => r.refusal === 'paused').length
      const moved = rs.slice(0, 5).filter((r) => r.ok).length
      same(refused + moved, 5, 'every start was either moved or refused for the pause')
      await drop(direct, p)
    },
  },
  {
    name: 'two claims on one application: one wins',
    run: async ({ direct }) => {
      const p = await mkPerson(direct, { send: true })
      const id = await mkAllowed(direct, p, 'one')
      const cs = await connect(POOLER, 2)
      const rs = await Promise.all([
        move(cs[0], id, ['ready'], 'applying', claimBody(p, id, {})),
        move(cs[1], id, ['ready'], 'applying', { ...claimBody(p, id), idempotency_key: `race-claim-b:${id}` }),
      ])
      same(rs.filter((r) => r.ok && !r.replay).length, 1, 'claims that won')
      const { rows } = await direct.query("select count(*)::int as n from public.pipeline_events where application_id = $1 and kind = 'fill.auto_started'", [id])
      same(rows[0].n, 1, 'claim events')
      await drop(direct, p)
    },
  },
  {
    name: 'ten claims under a send cap of 3 let exactly three through',
    run: async ({ direct }) => {
      const p = await mkPerson(direct, { send: true })
      const ids = []
      for (let i = 0; i < 10; i++) ids.push(await mkAllowed(direct, p, i))
      const cs = await connect(POOLER, 10)
      const rs = await Promise.all(cs.map((c, i) => move(c, ids[i], ['ready'], 'applying', claimBody(p, ids[i]))))
      same(rs.filter((r) => r.ok).length, 3, 'claims let through')
      same(rs.filter((r) => r.refusal === 'cap').length, 7, 'claims refused for the cap')
      await drop(direct, p)
    },
  },
  {
    name: 'two submission.sending calls for one application write one event',
    run: async ({ direct }) => {
      const p = await mkPerson(direct, { send: true })
      const id = await mkAllowed(direct, p, 'send')
      const claim = await move(direct, id, ['ready'], 'applying', claimBody(p, id))
      if (!claim.ok) throw new Error(`claim: ${JSON.stringify(claim)}`)
      const files = [{ name: 'resume.pdf', sha256: 'aa' }]
      const served = await direct.query(
        "select public.pipeline_note($1::uuid, $2::uuid, $3::jsonb) as r",
        [p.u, id, JSON.stringify(ev('fill.started', 'extension', `race-fs:${id}`, { payload: { auto: true, files } }))],
      )
      if (!served.rows[0].r.ok) throw new Error(`fill.started: ${JSON.stringify(served.rows[0].r)}`)
      const sending = () => ev('submission.sending', 'extension', `sending:${id}`, { payload: { token_id: p.tok, lease_holder: claim.lease_holder, files } })
      const cs = await connect(POOLER, 2)
      const rs = await Promise.all(cs.map((c) => move(c, id, ['applying'], 'applying', sending())))
      same(rs.filter((r) => r.ok).length, 2, 'both calls answered')
      same(rs.filter((r) => r.replay).length, 1, 'one of them a replay')
      same(rs[0].event.id, rs[1].event.id, 'the same event')
      const { rows } = await direct.query("select count(*)::int as n from public.pipeline_events where application_id = $1 and kind = 'submission.sending'", [id])
      same(rows[0].n, 1, 'sending events')
      await drop(direct, p)
    },
  },
  {
    name: 'Pause racing five claims leaves no claim after paused_at',
    run: async ({ direct }) => {
      const p = await mkPerson(direct, { send: true, maxPerDay: 10 })
      const ids = []
      for (let i = 0; i < 5; i++) ids.push(await mkAllowed(direct, p, i))
      const cs = await connect(POOLER, 6)
      const rs = await Promise.all([
        ...ids.map((id, i) => move(cs[i], id, ['ready'], 'applying', claimBody(p, id))),
        cs[5].query('select public.pipeline_pause($1::uuid)', [p.u]),
      ])
      const t = await pausedAt(direct, p)
      if (!t) throw new Error('the pause did not land')
      const { rows } = await direct.query(
        "select count(*)::int as n from public.pipeline_events where user_id = $1 and kind in ('fill.auto_started', 'submission.sending') and created_at > $2",
        [p.u, t],
      )
      same(rows[0].n, 0, 'claims written after paused_at')
      same(rs.slice(0, 5).filter((r) => r.ok || r.refusal === 'paused').length, 5, 'every claim was moved or refused for the pause')
      await drop(direct, p)
    },
  },
  {
    name: 'the person filling and an automatic claim race for one application: one takes it',
    run: async ({ direct }) => {
      const p = await mkPerson(direct, { send: true })
      const id = await mkAllowed(direct, p, 'both')
      const cs = await connect(POOLER, 2)
      const rs = await Promise.all([
        move(cs[0], id, ['ready'], 'applying', ev('fill.started', 'extension', `race-manual:${id}`, { payload: { auto: false } })),
        move(cs[1], id, ['ready'], 'applying', claimBody(p, id)),
      ])
      same(rs.filter((r) => r.ok).length, 1, 'the applications taken')
      same(rs.filter((r) => r.refusal === 'stale').length + rs.filter((r) => r.refusal === 'not_allowed').length, 1, 'the one refused')
      await drop(direct, p)
    },
  },
]
cases.push(...pipelineCases)

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
