// Ruling 5's wipe-at-expiry half for user-data class tables (RLS + demo
// wipe-at-expiry — as opposed to the privilege-bearing class's RLS +
// trigger deny + route refusal; see 20260817000003_graph_threads_demo_
// lockdown.sql's header for that split spelled out).
//
// WHY A SWEEP, NOT A TRIGGER
//   Expiry is time passing, not a row changing — nothing writes to
//   `profiles` or `interactions` at the moment a demo's window closes, so
//   there is no event a trigger could fire on. This has to be a periodic
//   sweep that notices "this became true" with nobody asking, which is
//   exactly what app/api/harness/cron/route.ts already is (invoked daily by
//   .github/workflows/harness-cron.yml) — this rides that existing tick as
//   one more pass rather than standing up a second scheduled path for one
//   DELETE.
//
// WHY demoSessionGate, NOT A FRESH `demo_expires_at < now()` QUERY
//   That gate is the canonical answer to "has this demo's access ended",
//   and it fails closed on a demo with NO deadline or an unparseable one
//   (see its own doc) — cases a naive `lt('demo_expires_at', now)` filter
//   would silently miss (`null < x` and `'garbage' < x` are never true in
//   SQL), leaving exactly the "lives forever" bug ruling 5 exists to close.
//   Reusing the gate keeps this sweep and every request-time refusal
//   agreeing about what "expired" means, the same reason demo-chokepoints
//   .test.ts pins middleware and guardrails to one answer.
//
// ponytail: `interactions`, `insights`, `resume_claims`, `claim_evidence`,
// `company_merge_candidates`, `eval_verdicts`, `trace_spans` and (as of the
// A2A step) `a2a_tasks` are the ruling-5 user-data tables with a landed
// migration (a2a_tasks: 20260819000002_a2a_tasks.sql), so RULING_5_TABLES
// below lists those eight — joining this sweep by adding its table name to
// the array, not by standing up a parallel mechanism or a second per-table
// code block. `memories` is the one
// exception already wired below: it does not live in `public` (mem0's own
// table sits in the `mem0` schema, keyed by payload, not `user_id` — see
// supabase/migrations/20260816000006_memories.sql), so a generic
// `.from(table).delete().in('user_id', chunk)` pass can never reach it —
// it goes through MemoryStore.deleteAll(), the same chokepoint every other
// memory read/write does.
//
// KB TABLES (kb_sources/kb_documents/kb_chunks, INCLUDING company_id-linked
// docs — 20260816000003_kb_entity_refs.sql) ARE DELIBERATELY NOT HERE.
// Binding ruling 5 names exactly nine tables across both wipe classes
// (api_tokens, apply_phase_tokens, graph_threads; interactions, insights,
// memories, resume_claims, claim_evidence, company_merge_candidates,
// eval_verdicts, trace_spans, a2a_tasks) and kb_* is not one of them — this
// was verified, not assumed, before Step 10 landed. Each kb_* row DOES carry
// `user_id ... references public.profiles(id) on delete cascade`, so it
// WOULD be swept the instant a demo's profiles row is deleted — but nothing
// deletes that row at expiry: redemption converts a demo profile into a real
// account in place (same id, same row), and an UNredeemed expired demo's
// profiles row is simply left locked out — every read and write path is
// already refused via demoSessionGate (lib/access/guardrails.ts), the same
// access-refusal doctrine ruling 5's class-1 tables lean on for the columns
// this sweep does not delete either (jobs, companies, contacts: real product
// data, not privilege- or PII-adjacent in the way ruling 5 was written to
// bound). Access-gated is the answer here, not delete-gated; extending
// RULING_5_TABLES to kb_* would be adding a table the ruling never named,
// not fixing an oversight in it.

import type { AdminClient } from '@/lib/harness/types'
import { demoSessionGate, isDemoProfile, type DemoProfileFacts } from './guardrails'
import { chunkedIn } from '@/lib/supabase/chunked-in'
import { getMemoryStore } from '@/lib/memory/mem0-store'

export interface DemoWipeResult {
  table: string
  deleted: number
}

/** Every ruling-5 user-data table owned 1:1 by user_id, in delete order (no
 *  FK between them, so order doesn't matter for correctness — kept as
 *  migration-landing order for readability). claim_evidence is listed before
 *  resume_claims purely for readability (claim_evidence.claim_id already
 *  cascades on resume_claims delete, so either order deletes the same rows —
 *  this loop deletes both explicitly rather than relying on the cascade so
 *  each table's own `deleted` count in DemoWipeResult stays meaningful). */
const RULING_5_TABLES = [
  'interactions',
  'insights',
  'resume_claims',
  'claim_evidence',
  'company_merge_candidates',
  'eval_verdicts',
  'trace_spans',
  'a2a_tasks',
] as const

/**
 * Deletes ruling-5 user-data rows owned by a demo profile whose access has
 * ended (expired, undated, or unparseable — anything demoSessionGate
 * refuses). Never throws: a failed scan or delete is logged and returns an
 * empty/zero result rather than aborting the cron tick's other passes,
 * matching that route's resume and digest passes.
 */
export async function wipeExpiredDemoData(
  admin: AdminClient,
  now: Date = new Date()
): Promise<DemoWipeResult[]> {
  const { data, error } = await admin
    .from('profiles')
    .select('id, is_demo, demo_expires_at')
    .or('is_demo.eq.true,demo_expires_at.not.is.null')
  if (error) {
    console.error(`[access:demo-wipe] profile scan failed: ${error.message}`)
    return []
  }

  const expiredIds = ((data ?? []) as (DemoProfileFacts & { id: string })[])
    .filter((p) => isDemoProfile(p) && !demoSessionGate(p, now).allowed)
    .map((p) => p.id)
  if (expiredIds.length === 0) return RULING_5_TABLES.map((table) => ({ table, deleted: 0 }))

  // System-wide, not owner-scoped by any FK join — chunked rather than one
  // .in() the way app/api/harness/cron/route.ts's own graph_threads lookup
  // already is (same file, same reason: this can outgrow a request's
  // querystring long before this codebase notices).
  const results: DemoWipeResult[] = []
  for (const table of RULING_5_TABLES) {
    const perChunkDeleted = await chunkedIn(expiredIds, async (chunk) => {
      const { error: delErr, count } = await admin
        .from(table)
        .delete({ count: 'exact' })
        .in('user_id', chunk)
      if (delErr) {
        console.error(`[access:demo-wipe] ${table} delete failed: ${delErr.message}`)
        return [0]
      }
      return [count ?? 0]
    })
    results.push({ table, deleted: perChunkDeleted.reduce((sum, n) => sum + n, 0) })
  }

  // Per-user, not chunked: MemoryStore.deleteAll takes one userId at a time
  // (mem0's own DeleteAllMemoryOptions shape), and this sweep runs at most
  // once a day over however many demos just expired — not a hot path worth
  // building a bulk primitive for. Never throws past this loop: one user's
  // deleteAll failing must not stop the next user's, matching the rest of
  // this sweep's fire-and-log posture.
  const memoryStore = getMemoryStore()
  let memoriesDeleted = 0
  for (const userId of expiredIds) {
    try {
      await memoryStore.deleteAll(userId)
      memoriesDeleted += 1
    } catch (err) {
      console.error(`[access:demo-wipe] memories deleteAll failed for ${userId}: ${(err as Error).message}`)
    }
  }
  results.push({ table: 'memories', deleted: memoriesDeleted })

  return results
}
