// The feature-facing entry point for knowledge-base retrieval. searchKb()
// (./store.ts) is a pure RPC wrapper — it fuses in a query vector only when
// one is HANDED to it. This module is what actually GETS that vector: embed
// the query, then search, degrading to FTS-only whenever embedding isn't
// possible or isn't fast enough. Call this from feature code (copilot tools,
// resume studio); call searchKb() directly only when you
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
import { MissingKeyError } from '../harness/llm'
import { BudgetCapError } from '../harness/spend'
import { captureError } from '../observability/sentry'
import { observe } from '../trace/spans'
import { embedMaterial } from './embed'
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
  // One Langfuse retriever observation (its embed-query nests under it) when
  // a trace is active. The query, hit titles and a 300 char excerpt of each are capture-gated (and masked at the Langfuse choke point).
  const state = { fts: false }
  return observe(
    { name: 'retrieve-knowledge', type: 'retriever', persist: false, foldEmbeddings: true },
    () => retrieveKbInner(admin, userId, query, opts, state),
    (hits, _err, capture) => ({
      // Without a query vector the search is FTS-only: a normal fallback, not an error.
      metadata: { limit: opts.limit ?? 0, ...(hits ? { hits: hits.length } : {}), ...(state.fts ? { fallback: 'fts-only' } : {}) },
      ...(capture
        ? { input: { query }, output: { hits: (hits ?? []).slice(0, 10).map((h) => ({ title: h.title, url: h.url, rank: h.rank, excerpt: h.content.slice(0, 300) })) } }
        : {}),
    })
  )
}

async function retrieveKbInner(
  admin: SupabaseClient,
  userId: string,
  query: string,
  opts: { limit?: number; companyId?: string },
  state: { fts: boolean }
): Promise<KbSearchHit[]> {
  const trimmed = (query ?? '').trim()
  // Same short circuit as searchKb(): an empty query can't match anything,
  // so there's nothing worth spending an embedding call on.
  if (!trimmed || !userId) return []

  let vector: number[] | undefined
  try {
    const keys = await loadApiKeys(admin, userId)
    const [embedded] = await embedMaterial(keys, [trimmed], 'embed-query', AbortSignal.timeout(EMBED_TIMEOUT_MS))
    // A vector that is not 384 long comes back null: the search is words only.
    vector = embedded ?? undefined
  } catch (err) {
    if (!(err instanceof MissingKeyError) && !(err instanceof BudgetCapError) && !isTimeout(err)) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error(`[kb:retrieve-embed-failed] user=${userId}: ${error.message}`)
      void captureError(error, { tags: { area: 'kb', phase: 'retrieve-embed' }, extra: { userId } })
    }
    // vector stays undefined — searchKb() degrades to FTS-only.
    state.fts = true
  }

  return searchKb(admin, userId, trimmed, { limit: opts.limit, companyId: opts.companyId, vector })
}

/** AbortSignal.timeout() firing raises a DOMException/Error named this. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}
