// Types for the knowledge base: public.kb_sources -> kb_documents -> kb_chunks.
//
// Mirrors supabase/migrations/20260724000002_phaseB.sql. None of these tables is
// in @cello/shared's generated `Database` type, so lib/kb/store.ts uses an
// untyped Supabase client with the row shapes declared here.
//
// THE SHAPE OF THE KB
//   kb_sources    one configured connector (a resume, an Apify actor, a URL, ...)
//   kb_documents  one retrieved item from a source
//   kb_chunks     retrieval-sized slices of a document, each with a GENERATED
//                 `tsv` tsvector. Search is Postgres full-text only — there is
//                 no embedding column and pgvector is not installed.

import type { ChunkOptions } from './chunk'

/**
 * Connector kinds. Enforced in TypeScript only — kb_sources.kind has no CHECK
 * constraint, so a new connector ships without a migration.
 *   resume          the user's own resume text
 *   linkedin_export a LinkedIn data export
 *   apify           output of an Apify actor run
 *   paste           text the user pasted directly
 *   url             a fetched web page
 *   gmail           message bodies pulled from Gmail
 *   dossier         a generated company dossier
 */
export type KbSourceKind =
  | 'resume'
  | 'linkedin_export'
  | 'apify'
  | 'paste'
  | 'url'
  | 'gmail'
  | 'dossier'

export const KB_SOURCE_KINDS = [
  'resume',
  'linkedin_export',
  'apify',
  'paste',
  'url',
  'gmail',
  'dossier',
] as const

/** Narrowing guard for values arriving from the DB or a request body. */
export function isKbSourceKind(value: unknown): value is KbSourceKind {
  return typeof value === 'string' && (KB_SOURCE_KINDS as readonly string[]).includes(value)
}

/**
 * Connector configuration blob (kb_sources.config).
 *
 * NEVER put an API key in here. BYOK secrets live AES-encrypted in
 * profiles.preferences.api_keys and are read by lib/harness/keys.ts /
 * lib/apikeys.ts. This column is world-readable to its owner and is not
 * encrypted.
 */
export interface KbSourceConfig {
  /** Apify actor id, e.g. 'apify~website-content-crawler'. */
  actorId?: string
  /** Apify actor input, passed through verbatim. */
  input?: Record<string, unknown>
  /** Target URL for the `url` kind. */
  url?: string
  /** Gmail search query for the `gmail` kind. */
  query?: string
  /** Room for connector-specific fields without a type change. */
  [key: string]: unknown
}

/** Row shape of public.kb_sources. */
export interface KbSource {
  id: string
  user_id: string
  kind: KbSourceKind
  label: string | null
  config: KbSourceConfig | null
  enabled: boolean
  /** ISO timestamp of the last successful sync, or null if never synced. */
  last_synced_at: string | null
  /** Message from the last failed sync. Null once a sync succeeds. */
  last_error: string | null
  created_at: string
}

/** Row shape of public.kb_documents. */
export interface KbDocument {
  id: string
  user_id: string
  source_id: string
  /**
   * Upstream stable id, used to dedupe re-syncs. Null for pastes — the unique
   * index excludes nulls, so null-external_id documents never collide.
   */
  external_id: string | null
  title: string | null
  url: string | null
  content: string
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/**
 * Row shape of public.kb_chunks. `tsv` is GENERATED ALWAYS in Postgres and is
 * deliberately absent here — writing it is an error, and reading it is useless
 * in JS.
 */
export interface KbChunk {
  id: string
  user_id: string
  document_id: string
  /** 0-based position within the parent document. */
  ord: number
  content: string
  created_at: string
}

/** Input for creating a connector. */
export interface NewKbSource {
  userId: string
  kind: KbSourceKind
  label?: string | null
  config?: KbSourceConfig | null
  enabled?: boolean
}

/**
 * Input for upsertDocument(). Identify the target row with EITHER:
 *   - `documentId` — update this exact document, or
 *   - `externalId` — update the document with this id under `sourceId`, or
 *   - neither — always insert a new document (the right choice for pastes).
 */
export interface UpsertDocumentInput {
  userId: string
  sourceId: string
  /** Explicit update target. Wins over `externalId` when both are given. */
  documentId?: string
  externalId?: string | null
  title?: string | null
  url?: string | null
  content: string
  metadata?: Record<string, unknown> | null
  /** Override chunk sizing for this document. Defaults come from ./chunk.ts. */
  chunkOptions?: ChunkOptions
}

export interface UpsertDocumentResult {
  document: KbDocument
  /** Number of chunks written for this document (its previous chunks are gone). */
  chunkCount: number
}

/**
 * One ranked search result, joined to its document so the caller can cite it.
 * Returned by searchKb() from the search_kb_chunks() SQL function.
 */
export interface KbSearchHit {
  chunkId: string
  documentId: string
  sourceId: string
  ord: number
  /** The matching chunk text — this is what you put in an LLM prompt. */
  content: string
  /** Document title, for the citation label. May be null. */
  title: string | null
  /** Document URL, for the citation link. May be null. */
  url: string | null
  /** ts_rank_cd score. Higher is better; only comparable within one query. */
  rank: number
}
