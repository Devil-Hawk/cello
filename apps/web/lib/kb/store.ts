// CRUD + full-text retrieval for the knowledge base.
//
// The kb_* tables are not in @cello/shared's generated Database type, so this
// uses an untyped SupabaseClient with the row shapes from ./types.ts — the same
// convention as lib/dossier/store.ts.
//
// WHICH CLIENT TO PASS
//   Pass the service-role admin client (lib/harness/supabase-admin.ts
//   createAdminClient()) from API routes, cron jobs and agents. Service-role
//   BYPASSES RLS, so every function here filters on `user_id` explicitly — that
//   predicate is the only thing separating users. Never remove it. The
//   cookie-scoped RLS client also works (reads are then filtered twice).
//
// SEARCH IS HYBRID (FTS + optional vector), OVER THE PERSON'S OWN MATERIAL
//   searchKb() calls the search_material() SQL function, which ranks with
//   ts_rank_cd over the GENERATED `tsv` column and, when `opts.vector` is
//   given, fuses that with a cosine-distance ranking over
//   kb_chunks.embedding_384 via Reciprocal Rank Fusion - see
//   supabase/migrations/20261123000000_material_expand.sql. It returns only
//   what the person gave Cello (never a page Cello fetched) and only sources
//   whose "Cello may use this" switch is on. Omit `opts.vector` (or call via
//   lib/kb/retrieve.ts#retrieveKb, which degrades to words only on its own)
//   for pure full-text behavior.

import type { SupabaseClient } from '@supabase/supabase-js'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { createAdminClient } from '../harness/supabase-admin'
import { loadApiKeys } from '../harness/keys'
import { embedMaterial } from './embed'
import { captureError } from '../observability/sentry'
import { withTrace } from '../trace/spans'
import type {
  KbDocument,
  KbSearchHit,
  KbSource,
  KbSourceConfig,
  NewKbSource,
  UpsertDocumentInput,
  UpsertDocumentResult,
} from './types'

const SOURCES = 'kb_sources'
const DOCUMENTS = 'kb_documents'
const CHUNKS = 'kb_chunks'

/** Name of the ranked-search SQL function (material expand migration). */
const SEARCH_FN = 'search_material'

/** Default chunk sizing: about 300 tokens, with a seam overlap so a fact on a boundary is in one chunk. */
const CHUNK_SIZE = 1200
const CHUNK_OVERLAP = 150

interface Piece {
  /** 0-based position within the document. */
  ord: number
  content: string
}

/** Rows per chunk INSERT. Keeps a single request body well under any body cap. */
const CHUNK_INSERT_BATCH = 200

/** Default and maximum hits returned by searchKb(). The SQL side clamps to 100. */
const DEFAULT_SEARCH_LIMIT = 12
const MAX_SEARCH_LIMIT = 100

/** Hard ceiling on list queries. */
const MAX_LIST_LIMIT = 500

// --- sources -----------------------------------------------------------------

/** All connectors for a user, newest first. */
export async function listSources(
  client: SupabaseClient,
  userId: string
): Promise<KbSource[]> {
  const { data, error } = await client
    .from(SOURCES)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`listSources failed: ${error.message}`)
  return (data as KbSource[]) ?? []
}

/** One connector by id, scoped to its owner. */
export async function getSource(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<KbSource | null> {
  const { data, error } = await client
    .from(SOURCES)
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`getSource failed: ${error.message}`)
  return (data as KbSource | null) ?? null
}

/** Create a connector. */
export async function createSource(
  client: SupabaseClient,
  input: NewKbSource
): Promise<KbSource> {
  if (!input.userId) throw new Error('createSource failed: userId is required')
  const row = {
    user_id: input.userId,
    kind: input.kind,
    label: input.label ?? null,
    config: input.config ?? null,
    enabled: input.enabled ?? true,
  }
  const { data, error } = await client.from(SOURCES).insert(row).select('*').single()
  if (error) throw new Error(`createSource failed: ${error.message}`)
  return data as KbSource
}

/** Patch a connector's label / config / enabled flag. */
export async function updateSource(
  client: SupabaseClient,
  userId: string,
  id: string,
  patch: { label?: string | null; config?: KbSourceConfig | null; enabled?: boolean; mayUse?: boolean }
): Promise<KbSource> {
  const fields: Record<string, unknown> = {}
  if (patch.label !== undefined) fields.label = patch.label
  if (patch.config !== undefined) fields.config = patch.config
  if (patch.enabled !== undefined) fields.enabled = patch.enabled
  if (patch.mayUse !== undefined) fields.may_use = patch.mayUse
  if (Object.keys(fields).length === 0) {
    throw new Error('updateSource failed: nothing to update')
  }

  const { data, error } = await client
    .from(SOURCES)
    .update(fields)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw new Error(`updateSource failed: ${error.message}`)
  return data as KbSource
}

/**
 * Record the outcome of a sync attempt. Pass `error` to record a failure
 * (leaving last_synced_at untouched) or omit it to mark success and clear any
 * previous error.
 */
export async function recordSync(
  client: SupabaseClient,
  userId: string,
  id: string,
  error?: string | null
): Promise<void> {
  const fields = error
    ? { last_error: error.slice(0, 2000) }
    : { last_synced_at: new Date().toISOString(), last_error: null }

  const { error: dbError } = await client
    .from(SOURCES)
    .update(fields)
    .eq('id', id)
    .eq('user_id', userId)
  if (dbError) throw new Error(`recordSync failed: ${dbError.message}`)
}

/** Delete a connector. Its documents and chunks cascade away. */
export async function deleteSource(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<void> {
  const { error } = await client
    .from(SOURCES)
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw new Error(`deleteSource failed: ${error.message}`)
}

// --- documents ---------------------------------------------------------------

/**
 * Column payload for the UPDATE half of upsertDocument(). Exported for tests.
 *
 * OMITTED-MEANS-UNCHANGED: only keys explicitly present on `input` are written,
 * so a re-sync that refreshes just `content` PRESERVES the document's existing
 * title / url / metadata. Passing an explicit `null` still clears a field. This
 * matches updateSource() and lib/resume/store.ts updateVersionMeta().
 *
 * Do NOT "simplify" this back to `title: input.title ?? null` — that nulls out
 * every field the caller did not resend, which silently destroyed `url` and
 * `metadata` on content-only re-ingests.
 *
 * `content` is required by UpsertDocumentInput, so it is always written. Note
 * `external_id` is deliberately never patched: it is the identity used to find
 * this row, not a mutable attribute.
 */
export function buildDocumentPatch(
  input: Pick<UpsertDocumentInput, 'title' | 'url' | 'metadata' | 'companyId' | 'contactId' | 'jobId'> & {
    content?: string
  }
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (input.content !== undefined) patch.content = input.content
  if (input.title !== undefined) patch.title = input.title
  if (input.url !== undefined) patch.url = input.url
  if (input.metadata !== undefined) patch.metadata = input.metadata
  if (input.companyId !== undefined) patch.company_id = input.companyId
  if (input.contactId !== undefined) patch.contact_id = input.contactId
  if (input.jobId !== undefined) patch.job_id = input.jobId
  return patch
}

/**
 * Insert-or-update one document and REPLACE its chunks.
 *
 * FIELD SEMANTICS ON UPDATE: omitted fields are left unchanged (see
 * buildDocumentPatch). Pass an explicit `null` to clear one.
 *
 * WHY NOT `.upsert({ onConflict: 'source_id,external_id' })`:
 *   the unique index is PARTIAL (`where external_id is not null`). PostgREST
 *   emits `ON CONFLICT (source_id, external_id)` with no WHERE clause, which
 *   cannot infer a partial index — Postgres rejects it with "there is no unique
 *   or exclusion constraint matching the ON CONFLICT specification". So the
 *   target row is resolved with an explicit read first.
 *
 * TARGET RESOLUTION (see UpsertDocumentInput):
 *   documentId -> that row; else externalId -> that (source_id, external_id)
 *   row; else always INSERT a new document.
 *
 * ATOMICITY: PostgREST gives no cross-request transaction, so this is
 * delete-chunks-then-insert-chunks. If the insert half fails, the document
 * survives with zero chunks — it is simply unsearchable until the caller
 * re-runs upsertDocument, which is idempotent. Chunks are never left in a
 * half-old/half-new state, because the delete always precedes the insert.
 */
export async function upsertDocument(
  client: SupabaseClient,
  input: UpsertDocumentInput
): Promise<UpsertDocumentResult> {
  const content = input.content?.trim()
  if (!content) throw new Error('upsertDocument failed: content is empty')
  if (!input.userId) throw new Error('upsertDocument failed: userId is required')
  if (!input.sourceId) throw new Error('upsertDocument failed: sourceId is required')

  const externalId = input.externalId ?? null

  // 1. Resolve the target row, if any.
  let existing: KbDocument | null = null
  if (input.documentId) {
    const { data, error } = await client
      .from(DOCUMENTS)
      .select('*')
      .eq('id', input.documentId)
      .eq('user_id', input.userId)
      .maybeSingle()
    if (error) throw new Error(`upsertDocument failed (lookup): ${error.message}`)
    if (!data) throw new Error('upsertDocument failed: documentId not found')
    existing = data as KbDocument
  } else if (externalId) {
    const { data, error } = await client
      .from(DOCUMENTS)
      .select('*')
      .eq('user_id', input.userId)
      .eq('source_id', input.sourceId)
      .eq('external_id', externalId)
      .maybeSingle()
    if (error) throw new Error(`upsertDocument failed (lookup): ${error.message}`)
    existing = (data as KbDocument | null) ?? null
  }

  // 2. Write the document.
  let document: KbDocument
  if (existing) {
    const { data, error } = await client
      .from(DOCUMENTS)
      // `content` here is the TRIMMED local, not input.content.
      .update({
        ...buildDocumentPatch({ ...input, content }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .eq('user_id', input.userId)
      .select('*')
      .single()
    if (error) throw new Error(`upsertDocument failed (update): ${error.message}`)
    document = data as KbDocument
  } else {
    const { data, error } = await client
      .from(DOCUMENTS)
      .insert({
        user_id: input.userId,
        source_id: input.sourceId,
        external_id: externalId,
        title: input.title ?? null,
        url: input.url ?? null,
        content,
        metadata: input.metadata ?? null,
        company_id: input.companyId ?? null,
        contact_id: input.contactId ?? null,
        job_id: input.jobId ?? null,
      })
      .select('*')
      .single()
    if (error) throw new Error(`upsertDocument failed (insert): ${error.message}`)
    document = data as KbDocument
  }

  // 3. Replace the chunks.
  const chunkCount = await replaceChunks(
    client,
    input.userId,
    document.id,
    content,
    input.chunkOptions
  )
  return { document, chunkCount }
}

/**
 * Re-chunk a document's text, discarding its previous chunks. Exported so a
 * caller can re-chunk with different sizing without rewriting the document.
 * Returns the number of chunks written.
 */
export async function replaceChunks(
  client: SupabaseClient,
  userId: string,
  documentId: string,
  content: string,
  chunkOptions?: UpsertDocumentInput['chunkOptions']
): Promise<number> {
  const { error: deleteError } = await client
    .from(CHUNKS)
    .delete()
    .eq('document_id', documentId)
    .eq('user_id', userId)
  if (deleteError) {
    throw new Error(`replaceChunks failed (delete): ${deleteError.message}`)
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: chunkOptions?.chunkSize ?? CHUNK_SIZE,
    chunkOverlap: chunkOptions?.chunkOverlap ?? CHUNK_OVERLAP,
  })
  const pieces: Piece[] = (await splitter.splitText(content))
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, ord) => ({ ord, content: text }))
  if (pieces.length === 0) return 0

  // NOTE: `tsv` is GENERATED ALWAYS — it must never appear in an insert payload.
  const rows = pieces.map((piece) => ({
    user_id: userId,
    document_id: documentId,
    ord: piece.ord,
    content: piece.content,
  }))

  for (let i = 0; i < rows.length; i += CHUNK_INSERT_BATCH) {
    const batch = rows.slice(i, i + CHUNK_INSERT_BATCH)
    const { error } = await client.from(CHUNKS).insert(batch)
    if (error) throw new Error(`replaceChunks failed (insert): ${error.message}`)
  }

  await embedChunksBestEffort(userId, documentId, pieces)
  return rows.length
}

/**
 * Embed the chunks just written by replaceChunks() and persist them onto
 * their rows, so search_material can rank this document in its vector
 * candidate list too (see 20261123000000_material_expand.sql). NEVER throws:
 * any failure — no provider configured, budget cap hit, a transient provider
 * error, a persist error on some subset of rows — leaves the affected
 * chunk(s) at their default NULL embedding, which search_material already
 * treats as "FTS-only for this row". Ingestion (upsertDocument) must never
 * fail because embedding did.
 *
 * Uses its OWN admin client for loadApiKeys regardless of which client the
 * caller passed to replaceChunks (see this file's WHICH CLIENT TO PASS
 * header) — loadApiKeys needs service-role access to read the user's
 * decrypted provider keys, which a cookie-scoped RLS client cannot do.
 *
 * One embedMaterial call batches every chunk's text (provider embedding APIs
 * are batch-native), so this is one provider round trip per document
 * regardless of chunk count — only the per-row persist afterward is N calls,
 * and kb_chunks has no unique constraint on (document_id, ord) to upsert
 * against instead (see idx_kb_chunks_document_ord — a plain, non-unique
 * index), so each row is written with its own scoped UPDATE.
 */
async function embedChunksBestEffort(
  userId: string,
  documentId: string,
  pieces: Piece[]
): Promise<void> {
  if (pieces.length === 0) return
  try {
    const admin = createAdminClient()
    const keys = await loadApiKeys(admin, userId)
    // Its own Langfuse trace when no request trace is active (ingest runs from
    // upload routes and scripts). Counts only: chunk text is never captured.
    const embeddings = await withTrace(
      admin,
      userId,
      { name: 'ingest-knowledge', input: { chunks: pieces.length, document_id: documentId }, isDemo: keys.isDemo },
      () => embedMaterial(keys, pieces.map((p) => p.content), 'embed-chunks')
    )
    for (let i = 0; i < pieces.length; i++) {
      // No 384 vector for this chunk: it stays NULL and is found by words.
      if (!embeddings[i]) continue
      const { error } = await admin
        .from(CHUNKS)
        .update({ embedding_384: embeddings[i] })
        .eq('document_id', documentId)
        .eq('user_id', userId)
        .eq('ord', pieces[i].ord)
      if (error) throw new Error(`persist embedding failed (ord=${pieces[i].ord}): ${error.message}`)
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    console.error(
      `[kb:embed-failed] document=${documentId} user=${userId} chunks=${pieces.length}: ${error.message}`
    )
    void captureError(error, {
      tags: { area: 'kb', phase: 'embed' },
      extra: { userId, documentId, chunkCount: pieces.length },
    })
  }
}

/**
 * Documents for a user, newest first. Optionally filtered to one source, or (`personOnly`)
 * to what the person gave Cello and left switched on: never a page Cello fetched, never a
 * source with "Cello may use this" off. Anything that quotes material as the person's own
 * words (resume claims) must pass it.
 */
export async function listDocuments(
  client: SupabaseClient,
  userId: string,
  opts: { sourceId?: string; limit?: number; personOnly?: boolean } = {}
): Promise<KbDocument[]> {
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, opts.limit ?? 100))
  // The join keeps the filter in one query and off a list of ids (see the .in() allowlist test).
  let query = client
    .from(DOCUMENTS)
    .select(opts.personOnly ? '*, kb_sources!inner(material_kind, may_use)' : '*')
    .eq('user_id', userId)
  if (opts.sourceId) query = query.eq('source_id', opts.sourceId)
  if (opts.personOnly) query = query.eq('kb_sources.material_kind', 'person').eq('kb_sources.may_use', true)

  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listDocuments failed: ${error.message}`)
  // The embedded source is only there to filter on; callers get plain documents.
  return ((data ?? []) as unknown as Array<KbDocument & { kb_sources?: unknown }>).map(({ kb_sources: _joined, ...doc }) => doc)
}

/** One document by id, scoped to its owner. */
export async function getDocument(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<KbDocument | null> {
  const { data, error } = await client
    .from(DOCUMENTS)
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`getDocument failed: ${error.message}`)
  return (data as KbDocument | null) ?? null
}

/** Delete a document. Its chunks cascade away. */
export async function deleteDocument(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<void> {
  const { error } = await client
    .from(DOCUMENTS)
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw new Error(`deleteDocument failed: ${error.message}`)
}

// --- search ------------------------------------------------------------------

/** Raw row shape returned by the search_material() SQL function. */
interface SearchRow {
  chunk_id: string
  document_id: string
  source_id: string
  ord: number
  content: string
  title: string | null
  url: string | null
  rank: number
}

/**
 * Ranked search over the user's chunks, joined to their documents for
 * citation. FTS-only (ts_rank_cd desc) unless `opts.vector` is given, in
 * which case the SQL side fuses it with the FTS ranking via Reciprocal Rank
 * Fusion - see supabase/migrations/20261123000000_material_expand.sql. This
 * function itself does no fusion math; it is a pure RPC wrapper, same as
 * before hybrid search existed. lib/kb/retrieve.ts is what supplies
 * `opts.vector` (embedding the query, degrading to FTS-only on failure) —
 * call THAT from feature code; call this directly only when you already
 * have a vector or deliberately want FTS-only.
 *
 * The query goes through websearch_to_tsquery('english', ...), so it accepts
 * plain words plus the familiar web operators: `"exact phrase"`, `or`, and a
 * leading `-` to exclude. Nonsense, empty and stop-word-only queries match
 * nothing and return [] rather than throwing.
 *
 * `limit` is clamped to 1..100 (also enforced SQL-side).
 */
export async function searchKb(
  client: SupabaseClient,
  userId: string,
  query: string,
  opts: { limit?: number; vector?: number[]; companyId?: string } = {}
): Promise<KbSearchHit[]> {
  const trimmed = (query ?? '').trim()
  // Skip the round trip: an empty tsquery can never match a row, and with no
  // vector either there is nothing for the SQL side to rank at all.
  if (!trimmed || !userId) return []

  const limit = Math.min(
    MAX_SEARCH_LIMIT,
    Math.max(1, opts.limit ?? DEFAULT_SEARCH_LIMIT)
  )

  const { data, error } = await client.rpc(SEARCH_FN, {
    p_user_id: userId,
    p_query: trimmed,
    p_limit: limit,
    p_vec: opts.vector ?? null,
    p_company_id: opts.companyId ?? null,
  })
  if (error) throw new Error(`searchKb failed: ${error.message}`)

  return ((data as SearchRow[]) ?? []).map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    sourceId: row.source_id,
    ord: row.ord,
    content: row.content,
    title: row.title,
    url: row.url,
    rank: row.rank,
  }))
}

/** Separator between rendered citation blocks. */
const CONTEXT_SEP = '\n\n'

/** Marker appended to a chunk whose text had to be cut to fit the budget. */
const TRUNCATION_MARK = '…'

/**
 * Render search hits as a citation block for an LLM prompt.
 *
 * Kept here so every consumer (copilot tool, resume studio)
 * formats retrieved context identically. `maxChars` caps the total so a big
 * result set cannot blow a prompt budget (floor 500, default 6000).
 *
 * NEVER RETURNS '' FOR A NON-EMPTY `hits`: a default 1200-char chunk does not
 * fit a tight budget, and an earlier version simply broke out of the loop and
 * returned an empty string — handing the model no context at all while looking
 * like a successful retrieval. Instead the first hit is TRUNCATED to fit, so a
 * caller always gets the best-ranked evidence plus its citation header.
 * Subsequent hits are dropped whole rather than cut.
 */
export function formatKbContext(
  hits: KbSearchHit[],
  opts: { maxChars?: number } = {}
): string {
  const maxChars = Math.max(500, opts.maxChars ?? 6000)
  const parts: string[] = []
  let total = 0

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    const label = hit.title || hit.url || 'untitled source'
    // Only the person's own material reaches here (search_material), so every hit is theirs to cite.
    const header = `[${i + 1}] From your notes: ${label}${hit.url ? ` (${hit.url})` : ''}`
    const block = `${header}\n${hit.content}`
    const cost = total ? CONTEXT_SEP.length + block.length : block.length

    if (total + cost <= maxChars) {
      parts.push(block)
      total += cost
      continue
    }

    // Doesn't fit. Only the FIRST hit is worth truncating — a fragment of a
    // lower-ranked chunk adds noise, so those are dropped entirely.
    if (parts.length === 0) {
      const room = maxChars - header.length - 1 - TRUNCATION_MARK.length
      if (room > 0) {
        parts.push(`${header}\n${hit.content.slice(0, room).trimEnd()}${TRUNCATION_MARK}`)
      } else {
        // Pathological: the header alone blows the budget. Emit it cut to length
        // so the caller still sees which document matched.
        parts.push(header.slice(0, maxChars))
      }
    }
    break
  }
  return parts.join(CONTEXT_SEP)
}
