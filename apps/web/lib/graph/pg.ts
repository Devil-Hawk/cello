// Runtime (non-DDL) access to the LangGraph checkpointer's Postgres tables.
//
// WHY THIS IS SEPARATE FROM scripts/setup-checkpointer.ts
//   setup-checkpointer.ts runs PostgresSaver.setup() ONCE, over the DIRECT
//   connection (port 5432) — see that script's header for why DDL needs a
//   session-level connection the transaction pooler can't give it. Everything
//   in this file is the opposite: a per-request, runtime read/write against
//   tables setup() already created, over the POOLER (port 6543,
//   SUPABASE_DB_URL) — the connection Vercel's serverless functions can
//   actually hold open for the length of an invoke.
//
// WHY max: 1 AND NO MODULE-LEVEL POOL
//   A serverless function instance runs one invocation at a time but can be
//   frozen/thawed between them, and a pooled Pool cached at module scope would
//   leak connections across cold starts under the transaction pooler (which
//   expects short-lived sessions, not a long-lived idle pool sitting on a
//   pinned backend). withCheckpointer() opens exactly one connection for the
//   duration of `fn` and always closes it — see the `finally`.
//
// TLS: same relaxation as setup-checkpointer.ts, against the same database —
// `sslmode` is stripped from the URL (pg's own `ssl` option is what actually
// configures TLS; leaving a conflicting `sslmode` query param means pg fights
// itself over which one wins) and `rejectUnauthorized: false` is passed
// explicitly because Supabase's chain is self-signed from Node's default
// trust store. This does not disable encryption, only chain verification.

import { Pool } from 'pg'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'

const CHECKPOINTER_SCHEMA = 'langgraph'

/**
 * Strip `sslmode` (and its leading `?`/`&`) from a Postgres connection string
 * so it cannot fight with an explicit `ssl` option passed to `Pool`. Shared
 * with scripts/setup-checkpointer.ts so the two connection paths (pooler here,
 * direct there) can never drift on this one detail.
 */
export function parseDbUrl(raw: string): string {
  const url = new URL(raw)
  url.searchParams.delete('sslmode')
  return url.toString()
}

function resolvePoolerConnectionString(): string {
  const raw = process.env.SUPABASE_DB_URL
  if (!raw) {
    throw new Error(
      'Set SUPABASE_DB_URL to a POOLED (port 6543) Postgres connection string before invoking a graph. See apps/web/.env.example.'
    )
  }
  return parseDbUrl(raw)
}

/**
 * Open exactly one pooler connection, hand a PostgresSaver bound to it to
 * `fn`, and ALWAYS close the connection afterward — success, thrown error, or
 * rejected promise alike. Callers never see a Pool or a connection string.
 * lib/graph/invoke.ts is the only caller allowed to reach graph.invoke/stream
 * through the saver it gets here (that file's own header); countThreadCheckpoints
 * below is a second, narrower caller that only ever reads checkpoint history.
 */
export async function withCheckpointer<T>(fn: (saver: PostgresSaver) => Promise<T>): Promise<T> {
  const connectionString = resolvePoolerConnectionString()
  const pool = new Pool({
    connectionString,
    max: 1,
    ssl: { rejectUnauthorized: false },
  })
  const saver = new PostgresSaver(pool, undefined, { schema: CHECKPOINTER_SCHEMA })
  try {
    return await fn(saver)
  } finally {
    await pool.end()
  }
}

/**
 * How many checkpoints exist for a thread, capped at `ceiling + 1` — the
 * pathology backstop app/api/harness/cron/route.ts's resume pass checks
 * before re-entering a thread, so a plan that lands back on the deadline
 * interrupt every single attempt forever gets closed out instead of retried
 * without end (the graph port deleted the old continuation-counter cap that
 * used to bound this — see lib/harness/types.ts's RunStatus['paused'] doc).
 *
 * Uses PostgresSaver#list rather than a raw `SELECT count(*)` against
 * langgraph.checkpoints: PostgresSaver's `pool` field is declared `private`
 * in @langchain/langgraph-checkpoint-postgres's own .d.ts, so reaching around
 * it would need an `as any` escape this codebase's scan forbids. `list` is
 * the library's own public, ordered read of exactly that table, and passing
 * `limit: ceiling + 1` bounds the query to answer a yes/no "over the ceiling?"
 * question instead of pulling a pathological thread's entire history.
 */
export async function countThreadCheckpoints(threadId: string, ceiling: number): Promise<number> {
  return withCheckpointer(async (saver) => {
    let count = 0
    for await (const _tuple of saver.list({ configurable: { thread_id: threadId } }, { limit: ceiling + 1 })) {
      count += 1
    }
    return count
  })
}
