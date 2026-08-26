/**
 * OWNER-RUN, METERED. Embeds every existing kb_chunks row that still has a
 * NULL embedding, via the same chokepoint feature code uses
 * (lib/harness/keys.ts#loadApiKeys -> lib/harness/llm.ts#callEmbedding), so
 * spend is recorded to each chunk owner's OWN monthly ledger exactly as if
 * they had triggered the embed themselves. NEVER auto-run: not scheduled, not
 * called by any request path, not invoked by this task — a human operator
 * runs it once, after the hybrid-search migration
 * (20260816000007_hybrid_search.sql) has landed, to backfill the vector
 * candidate list for content ingested before hybrid search existed. New
 * ingests need no backfill: lib/kb/store.ts#replaceChunks embeds every chunk
 * it writes, going forward.
 *
 * WHY PER-USER, NOT ONE GLOBAL CALL: callEmbedding needs one user's decrypted
 * provider keys and spends against that user's own budget cap
 * (assertWithinBudget / recordSpend) — there is no "embed for everyone" key.
 * Rows are grouped by user_id so each user's chunks go through their own
 * loadApiKeys() + callEmbedding() calls and their own spend ledger.
 *
 * A user with no embedding provider configured (no BYOK key, no Cello
 * credit routed to embeddings) throws MissingKeyError on their very first
 * batch — the script logs it as SKIPPED and moves to the next user rather
 * than retrying (there is nothing to retry: the config genuinely doesn't
 * exist). A user AT their monthly cap throws BudgetCapError the same way.
 * Neither is a bug in this script; both are reported in the summary.
 *
 *   # source the DB + service-role env first (never commit or echo these)
 *   set -a && source /path/to/prod.env && set +a
 *
 *   npx tsx scripts/backfill-embeddings.ts                 # embed + write
 *   npx tsx scripts/backfill-embeddings.ts --dry-run        # report only, spends nothing
 *   npx tsx scripts/backfill-embeddings.ts --limit 200      # smoke test (total rows, across all users)
 *
 * CONNECTION: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (SUPABASE_SERVICE_KEY
 *   also accepted) via lib/harness/supabase-admin.ts#createAdminClient() — the
 *   same service-role credentials every other apps/web/scripts/*.ts owner-run
 *   script uses (see scripts/closeout-incomplete-runs.ts).
 */
import { createAdminClient } from '../lib/harness/supabase-admin'
import { loadApiKeys } from '../lib/harness/keys'
import { callEmbedding, MissingKeyError } from '../lib/harness/llm'
import { BudgetCapError } from '../lib/harness/spend'

/** Chunks embedded per callEmbedding() call — one provider round trip per
 *  batch, well under any provider's per-request item cap. */
const EMBED_BATCH = 100

/** Rows read per page within one user's NULL-embedding chunks. */
const READ_PAGE = 500

interface ChunkRow {
  id: string
  document_id: string
  ord: number
  content: string
}

function parseArgs(argv: string[]) {
  const limitIdx = argv.indexOf('--limit')
  return {
    dryRun: argv.includes('--dry-run'),
    limit: limitIdx > -1 && argv[limitIdx + 1] ? Number(argv[limitIdx + 1]) : null,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const admin = createAdminClient()

  console.log('backfill-embeddings')
  console.log(`  mode  : ${args.dryRun ? 'DRY RUN (no writes, no spend)' : 'APPLY (writes + spends against each user\'s own cap)'}`)
  console.log(`  limit : ${args.limit ?? '(none — every NULL-embedding chunk)'}`)

  const { data: userRows, error: userErr } = await admin
    .from('kb_chunks')
    .select('user_id')
    .is('embedding', null)
  if (userErr) throw new Error(`user scan failed: ${userErr.message}`)
  const userIds = [...new Set((userRows ?? []).map((r) => r.user_id as string))]
  console.log(`\n${userIds.length} user(s) with at least one NULL-embedding chunk`)

  let scanned = 0
  let embedded = 0
  let rowFailures = 0
  const skipped: string[] = []
  const failedUsers: string[] = []

  userLoop: for (const userId of userIds) {
    if (args.limit !== null && scanned >= args.limit) break

    let afterId: string | null = null
    for (;;) {
      if (args.limit !== null && scanned >= args.limit) break

      const remaining = args.limit === null ? READ_PAGE : Math.min(READ_PAGE, args.limit - scanned)
      let query = admin
        .from('kb_chunks')
        .select('id, document_id, ord, content')
        .eq('user_id', userId)
        .is('embedding', null)
        .order('id', { ascending: true })
        .limit(remaining)
      if (afterId) query = query.gt('id', afterId)

      const { data, error } = await query
      if (error) throw new Error(`chunk read failed for user ${userId}: ${error.message}`)
      const rows = (data ?? []) as ChunkRow[]
      if (rows.length === 0) break
      afterId = rows[rows.length - 1].id
      scanned += rows.length

      if (args.dryRun) {
        process.stderr.write(`\r  scanned ${scanned} chunk(s)   `)
        if (rows.length < remaining) break
        continue
      }

      let keys
      try {
        keys = await loadApiKeys(admin, userId)
      } catch (err) {
        console.error(`\n  user ${userId}: loadApiKeys failed — ${err instanceof Error ? err.message : err}`)
        failedUsers.push(userId)
        continue userLoop
      }

      for (let i = 0; i < rows.length; i += EMBED_BATCH) {
        const batch = rows.slice(i, i + EMBED_BATCH)
        let embeddings: number[][]
        try {
          const result = await callEmbedding(keys, { texts: batch.map((r) => r.content) })
          embeddings = result.embeddings
        } catch (err) {
          if (err instanceof MissingKeyError || err instanceof BudgetCapError) {
            console.error(`\n  user ${userId}: ${err.message} — skipping this user's remaining chunks`)
            skipped.push(`${userId} (${err.name})`)
            continue userLoop
          }
          console.error(`\n  user ${userId}: embed batch failed — ${err instanceof Error ? err.message : err}`)
          rowFailures += batch.length
          continue
        }

        for (let j = 0; j < batch.length; j++) {
          const { error: updErr } = await admin
            .from('kb_chunks')
            .update({ embedding: embeddings[j] })
            .eq('id', batch[j].id)
          if (updErr) {
            console.error(`\n  chunk ${batch[j].id}: persist failed — ${updErr.message}`)
            rowFailures++
            continue
          }
          embedded++
        }
      }

      process.stderr.write(`\r  scanned ${scanned} chunk(s), embedded ${embedded}   `)
      if (rows.length < remaining) break
    }
  }
  process.stderr.write('\n')

  console.log(`\nchunks scanned    : ${scanned}`)
  if (!args.dryRun) {
    console.log(`chunks embedded   : ${embedded}`)
    console.log(`row failures      : ${rowFailures}`)
    console.log(`users skipped     : ${skipped.length}${skipped.length ? ` — ${skipped.join(', ')}` : ''}`)
    console.log(`users load-failed : ${failedUsers.length}${failedUsers.length ? ` — ${failedUsers.join(', ')}` : ''}`)
  } else {
    console.log('DRY RUN — nothing embedded, nothing written, nothing spent.')
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
