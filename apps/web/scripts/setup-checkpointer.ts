/**
 * One-time (idempotent) operational step: create/migrate the LangGraph
 * checkpointer's own tables inside the `langgraph` schema
 * (20260817000001_langgraph_schema.sql creates the schema itself; this
 * script is what populates it).
 *
 * WHY THIS IS A SCRIPT, NOT A MIGRATION FILE
 *   See the comment on 20260817000001_langgraph_schema.sql: the checkpointer
 *   tables are an implementation detail of @langchain/langgraph-checkpoint-postgres
 *   with their OWN internal versioned migration runner
 *   (langgraph.checkpoint_migrations). Vendoring their DDL into a Supabase
 *   migration would pin us to a schema shape that can drift from whatever the
 *   pinned package version (see the exact pins on @langchain/langgraph,
 *   @langchain/langgraph-checkpoint-postgres, @langchain/core in
 *   package.json — no caret ranges) actually expects on the next bump.
 *   PostgresSaver.setup() is the one thing allowed to create or alter them.
 *
 * CONNECTION: SUPABASE_DB_URL_DIRECT (falls back to POSTGRES_URL_NON_POOLING).
 *   DDL needs a DIRECT (non-pooled, port 5432) connection — pgbouncer's
 *   transaction-pooling mode (port 6543, what runtime traffic uses) does not
 *   support the session-level features CREATE TABLE / migrations rely on.
 *   See apps/web/.env.example for the pooler-vs-direct split.
 *
 * TLS: Supabase's root CA is not in Node's default trust store, so sslFor()
 * (lib/graph/pg.ts) pins it and verifies the server. `sslmode` is stripped out
 * of the connection string (pg's ssl object is what actually configures TLS;
 * leaving a conflicting `sslmode` query param in the URL causes pg to fight
 * itself over which one wins).
 *
 * Usage:
 *   set -a && source /path/to/prod.env && set +a
 *   pnpm setup:checkpointer
 */
import { Pool } from 'pg'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { parseDbUrl, sslFor } from '../lib/graph/pg'

const CHECKPOINTER_SCHEMA = 'langgraph'

// Logged after a successful setup() — not returned by the library, so this
// list is kept in sync with what @langchain/langgraph-checkpoint-postgres's
// own migrations.ts actually creates (checkpoint_migrations, checkpoints,
// checkpoint_blobs, checkpoint_writes) at the pinned package version.
const EXPECTED_TABLES = ['checkpoint_migrations', 'checkpoints', 'checkpoint_blobs', 'checkpoint_writes']

function resolveConnectionString(): string {
  const raw = process.env.SUPABASE_DB_URL_DIRECT ?? process.env.POSTGRES_URL_NON_POOLING
  if (!raw) {
    throw new Error(
      'Set SUPABASE_DB_URL_DIRECT (preferred) or POSTGRES_URL_NON_POOLING to a DIRECT (port 5432, non-pooled) Postgres connection string before running this script. See apps/web/.env.example.'
    )
  }

  // Strip `sslmode` (and its leading `?`/`&`) so it cannot fight with the
  // explicit `ssl` option passed to `Pool` below — pg reads both and a
  // mismatched pair produces confusing, connection-string-dependent failures.
  // Shared with lib/graph/pg.ts (the runtime/pooler counterpart of this
  // direct-connection setup script) so the two connection paths cannot drift
  // on this one detail.
  return parseDbUrl(raw)
}

async function main(): Promise<void> {
  const connectionString = resolveConnectionString()

  const pool = new Pool({
    connectionString,
    // Verified against the pinned Supabase root CA, same as the runtime
    // pooler path in lib/graph/pg.ts.
    ssl: sslFor(connectionString),
  })

  const saver = new PostgresSaver(pool, undefined, { schema: CHECKPOINTER_SCHEMA })

  try {
    console.log(`Running PostgresSaver.setup() against schema "${CHECKPOINTER_SCHEMA}"...`)
    await saver.setup()
    console.log(`Ensured tables in "${CHECKPOINTER_SCHEMA}":`)
    for (const table of EXPECTED_TABLES) {
      console.log(`  - ${CHECKPOINTER_SCHEMA}.${table}`)
    }
  } finally {
    await pool.end()
  }
}

main()
  .then(() => {
    console.log('setup-checkpointer: done.')
    process.exit(0)
  })
  .catch((err) => {
    console.error('setup-checkpointer: failed.', err)
    process.exit(1)
  })
