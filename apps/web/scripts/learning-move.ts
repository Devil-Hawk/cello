/**
 * OWNER-RUN, ONCE PER ENVIRONMENT, SAFE TO RUN AGAIN. Moves what Cello held in its two old
 * stores into the one learnings store (mem0), before migration 20261015000001 drops them:
 *
 *   public.insights                  active rows       -> proposed learnings, key earlier:<row id>
 *   mem0.memories (1536 dimensions)  every row         -> proposed learnings, key earlier:mem0:<id>
 *   public.strategy_proposal_outcomes every row        -> active outcome learnings (the person accepted them)
 *
 * Everything that was written by a model, or by a conversation, arrives as a proposal: it
 * shows under What Cello learned as "From earlier chats" and acts on nothing until the person
 * keeps it. Each row carries a key, so a second run finds it and adds nothing. It prints the
 * counts per source; the drop migration refuses to run unless the insight count is covered.
 *
 *   set -a && source /path/to/prod.env && set +a      # never commit or echo these
 *   npx tsx scripts/learning-move.ts --dry-run         # counts only, writes nothing
 *   npx tsx scripts/learning-move.ts
 *
 * CONNECTION: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the rows), SUPABASE_DB_URL_DIRECT
 * (mem0's tables and the old 1536-dimension collection).
 */
import { Client } from 'pg'
import { createAdminClient } from '../lib/harness/supabase-admin'
import { parseDbUrl, sslFor } from '../lib/graph/pg'
import { LEARNING_SCOPE } from '../lib/learning/types'
import { listAcceptedProposals } from '../lib/learning/outcomes'
import { allLearnings } from '../lib/learning/store'
import { getMemoryStore } from '../lib/memory/mem0-store'
import type { JobScopeCounts } from '../lib/strategy/datasource'

const dryRun = process.argv.includes('--dry-run')
const store = getMemoryStore()

interface Tally {
  found: number
  added: number
  skipped: number
}
const tally = (): Tally => ({ found: 0, added: 0, skipped: 0 })

/** One earlier row as a proposal, unless its key is already there. */
async function moveProposed(t: Tally, known: Map<string, Set<string>>, userId: string, key: string, statement: string, updatedAt: string, from: string): Promise<void> {
  t.found++
  const keys = known.get(userId) ?? new Set((await allLearnings(userId, store)).map((l) => l.key))
  known.set(userId, keys)
  if (keys.has(key) || !statement.trim()) {
    t.skipped++
    return
  }
  if (!dryRun) {
    await store.add(userId, {
      fact: statement.trim(),
      scope: LEARNING_SCOPE,
      isDemo: false,
      refs: { key, kind: 'earlier', effect: 'none', params: {}, status: 'proposed', origin: 'model', evidence: [], n: 0, updated_at: updatedAt, from },
    })
    keys.add(key)
  }
  t.added++
}

async function main(): Promise<void> {
  const admin = createAdminClient()
  const known = new Map<string, Set<string>>()
  const insights = tally()
  const memories = tally()
  const outcomes = tally()

  // 1. public.insights, active rows.
  const { data: rows, error } = await admin.from('insights').select('id, user_id, statement, updated_at').eq('status', 'active')
  if (error) throw new Error(`could not read insights: ${error.message}`)
  for (const r of (rows as { id: string; user_id: string; statement: string; updated_at: string }[] | null) ?? []) {
    await moveProposed(insights, known, r.user_id, `earlier:${r.id}`, r.statement, r.updated_at, 'insights')
  }

  // 2. The old 1536-dimension mem0 collection.
  const raw = process.env.SUPABASE_DB_URL_DIRECT ?? process.env.POSTGRES_URL_NON_POOLING
  if (raw) {
    const conn = parseDbUrl(raw)
    const pg = new Client({ connectionString: conn, ssl: sslFor(conn) })
    await pg.connect()
    try {
      const has = await pg.query("select to_regclass('mem0.memories') as t")
      if (has.rows[0]?.t) {
        const old = await pg.query("select id, payload->>'user_id' as user_id, payload->>'data' as data, payload->>'createdAt' as created from mem0.memories")
        for (const m of old.rows as { id: string; user_id: string | null; data: string | null; created: string | null }[]) {
          if (!m.user_id || !m.data) continue
          await moveProposed(memories, known, m.user_id, `earlier:mem0:${m.id}`, m.data, m.created ?? new Date().toISOString(), 'chats')
        }
      }
    } finally {
      await pg.end()
    }
  } else {
    console.log('SUPABASE_DB_URL_DIRECT is not set: the old mem0 collection was not read')
  }

  // 3. Accepted strategy proposals: the person accepted each one, so each is theirs and active.
  const { data: acc, error: accError } = await admin.from('strategy_proposal_outcomes').select('user_id, proposal_id, question, title, accepted_at, metrics_before')
  if (accError) throw new Error(`could not read strategy_proposal_outcomes: ${accError.message}`)
  const accepted = (acc as { user_id: string; proposal_id: string; question: string; title: string; accepted_at: string; metrics_before: JobScopeCounts }[] | null) ?? []
  for (const a of accepted) {
    outcomes.found++
    const already = (await listAcceptedProposals(a.user_id, store)).some((p) => p.proposalId === a.proposal_id && new Date(p.acceptedAt).getTime() === new Date(a.accepted_at).getTime())
    if (already) {
      outcomes.skipped++
      continue
    }
    if (!dryRun) {
      await store.add(a.user_id, {
        fact: `You accepted: ${a.title}`,
        scope: LEARNING_SCOPE,
        isDemo: false,
        refs: {
          key: `outcome:accepted:${a.proposal_id}:${a.accepted_at}`,
          kind: 'outcome',
          effect: 'search.propose',
          params: { proposalId: a.proposal_id, question: a.question },
          status: 'active',
          origin: 'person',
          evidence: [],
          n: 0,
          updated_at: a.accepted_at,
          title: a.title,
          accepted_at: a.accepted_at,
          metrics_before: a.metrics_before,
        },
      })
    }
    outcomes.added++
  }

  console.log(`${dryRun ? 'dry run: ' : ''}learning-move`)
  console.log('  insights            ', insights)
  console.log('  old mem0 memories   ', memories)
  console.log('  accepted proposals  ', outcomes)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
