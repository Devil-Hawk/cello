// The feature-facing entry point for knowledge-base retrieval. searchKb()
// (./store.ts) is a pure RPC wrapper — it fuses in a query vector only when
// one is HANDED to it. This module is what actually GETS that vector: embed
// the query, then search, degrading to FTS-only whenever embedding isn't
// possible or isn't fast enough. Call this from feature code (copilot tools,
// resume studio, interview prep); call searchKb() directly only when you
// already have a vector or deliberately want FTS-only.
//
// DEGRADATION IS THE WHOLE POINT: retrieval must never fail a turn because an
// embedding provider is unconfigured, capped, or slow. MissingKeyError (no
// provider configured) and BudgetCapError (this month's spend already at cap)
// are the two EXPECTED reasons embedding doesn't happen — every account
// without BYOK keys or Cello credit hits one of these on every call, so they
// are not logged as failures. Anything else (a provider timeout via the
// AbortSignal below, a transient HTTP error, a dimension mismatch) is
// unexpected and worth an operator's attention, so it's logged — but still
// degrades to FTS rather than throwing.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadApiKeys } from '../harness/keys'
import { callEmbedding, MissingKeyError } from '../harness/llm'
import { BudgetCapError } from '../harness/spend'
import { captureError } from '../observability/sentry'
import { searchKb } from './store'
import type { KbSearchHit } from './types'

/**
 * ponytail: fixed budget, not a per-provider/per-account setting — retrieval
 * sits in front of a chat turn, so this bounds the SLOWEST acceptable wait
 * for "maybe better ranking," not a correctness requirement (FTS-only is
 * always a safe, complete result). Revisit if a real provider proves
 * reliably slower than this under normal load.
 */
const EMBED_TIMEOUT_MS = 2500

/**
 * Embed `query` and run hybrid search; falls back to FTS-only search on any
 * embedding failure. Never throws for an embedding-side failure — searchKb's
 * own errors (a broken RPC, a bad connection) still propagate, exactly as
 * they do for every other searchKb() caller.
 */
export async function retrieveKb(
  admin: SupabaseClient,
  userId: string,
  query: string,
  opts: { limit?: number; companyId?: string } = {}
): Promise<KbSearchHit[]> {
  const trimmed = (query ?? '').trim()
  // Same short circuit as searchKb(): an empty query can't match anything,
  // so there's nothing worth spending an embedding call on.
  if (!trimmed || !userId) return []

  let vector: number[] | undefined
  try {
    const keys = await loadApiKeys(admin, userId)
    const { embeddings } = await callEmbedding(
      keys,
      { texts: [trimmed] },
      AbortSignal.timeout(EMBED_TIMEOUT_MS)
    )
    vector = embeddings[0]
  } catch (err) {
    if (!(err instanceof MissingKeyError) && !(err instanceof BudgetCapError) && !isTimeout(err)) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error(`[kb:retrieve-embed-failed] user=${userId}: ${error.message}`)
      void captureError(error, { tags: { area: 'kb', phase: 'retrieve-embed' }, extra: { userId } })
    }
    // vector stays undefined — searchKb() degrades to FTS-only.
  }

  return searchKb(admin, userId, trimmed, { limit: opts.limit, companyId: opts.companyId, vector })
}

/** AbortSignal.timeout() firing raises a DOMException/Error named this. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}
