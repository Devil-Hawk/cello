// Agent persistence: the thread checkpointer.
//
// LangGraph's PostgresSaver keeps each conversation's state, so a request can
// stop and the next one continue. It lives in the `langgraph` schema; the tables
// are created once by scripts/setup-checkpointer.ts over a direct connection. At
// runtime it uses the transaction pooler (port 6543), one small pool per
// request, always closed, never cached at module scope (a frozen serverless
// instance would keep idle connections pinned to a backend).
//
// There is no second memory store here: what Cello remembers about a person is
// mem0 (lib/memory), and the person's taste is read from their reactions.

import { Pool } from 'pg'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { resolvePoolerConnectionString, sslFor } from '@/lib/graph/pg'

export const AGENT_SCHEMA = 'langgraph'

export interface AgentPersistence {
  saver: PostgresSaver
}

/** Open the checkpointer for one request and always close it. */
export async function withAgentPersistence<T>(fn: (p: AgentPersistence) => Promise<T>): Promise<T> {
  const connectionString = resolvePoolerConnectionString()
  const pool = new Pool({ connectionString, max: 2, ssl: sslFor(connectionString) })
  const saver = new PostgresSaver(pool, undefined, { schema: AGENT_SCHEMA })
  try {
    return await fn({ saver })
  } finally {
    await pool.end()
  }
}
