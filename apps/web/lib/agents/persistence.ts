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

export interface AgentPersistenceHandle extends AgentPersistence {
  /** Close the pool. Always call it, success or failure. */
  close: () => Promise<void>
}

/** Open the checkpointer for one request. The caller closes the handle; a streaming request needs this form because its work spans many yields. */
export function openAgentPersistence(): AgentPersistenceHandle {
  const connectionString = resolvePoolerConnectionString()
  const pool = new Pool({ connectionString, max: 2, ssl: sslFor(connectionString) })
  const saver = new PostgresSaver(pool, undefined, { schema: AGENT_SCHEMA })
  return { saver, close: async () => void (await pool.end().catch(() => undefined)) }
}

/** The same, for work that fits in one function: opened, used, always closed. */
export async function withAgentPersistence<T>(fn: (p: AgentPersistence) => Promise<T>): Promise<T> {
  const handle = openAgentPersistence()
  try {
    return await fn(handle)
  } finally {
    await handle.close()
  }
}
