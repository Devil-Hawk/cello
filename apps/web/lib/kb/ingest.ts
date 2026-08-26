// The named door for writing entity-scoped documents into the knowledge base
// (Binding ruling 3: "Writers go through lib/insights/store.ts#ingestInsight()
// and lib/kb/ingest.ts only").
//
// Two writers live here, both idempotent via a stable external_id (re-ingesting
// the same page/company REPLACES its chunks via lib/kb/store.ts#upsertDocument
// — never duplicates):
//   ingestCompanyPage    one of a company's own home/about/careers pages, as
//                        fetched by lib/dossier/sources.ts#collectPublicSignals
//   ingestDossierSummary the LLM-synthesized (or Wikipedia-fallback) dossier
//                        summary
// Both stamp kb_documents.company_id (supabase/migrations/20260816000003_
// kb_entity_refs.sql) so a reader can find everything on file for a company
// without parsing external_id strings — see readFreshCompanyPages below, the
// read half lib/contacts/sources.ts uses to skip a redundant live fetch.
//
// NOT_JOB_TEXT (lib/security/injection-chokepoints.test.ts's ledger): this
// file builds no prompts and never calls an LLM — it only persists
// already-fetched/-synthesized text via upsertDocument. The text it stores IS
// employer-authored (the company's own pages), but the framing obligation
// belongs to whoever next puts that text in a prompt, not to the store.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createSource, upsertDocument } from './store'
import type { KbSourceKind } from './types'

const COMPANY_PAGES = ['home', 'about', 'careers'] as const
export type CompanyPage = (typeof COMPANY_PAGES)[number]

/** One page's stored text, ready to feed the same extractors a live fetch would. */
export interface StoredCompanyPage {
  url: string
  text: string
}

// ponytail: a live fetch beyond this age is preferred over trusting the cache.
// Company pages change rarely enough that two weeks is a comfortable default;
// tighten per-company if a real staleness complaint ever shows up.
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Find the user's singleton auto-provisioned source for `kind`, creating one
 * on first use. One row serves every company for this user — individual
 * documents are disambiguated by external_id, not by a source per company.
 *
 * ponytail: no unique index backs (user_id, kind), so a genuinely concurrent
 * first-ever ingest for the same user could create two rows here. Harmless —
 * every read below goes by company_id + external_id, never by source
 * uniqueness — so this stays a plain find-then-create rather than an upsert
 * PostgREST can't target anyway (see lib/kb/store.ts's own comment on why a
 * partial-index onConflict doesn't work). Add a unique index + real upsert if
 * duplicate auto-sources ever become an actual problem.
 */
async function getOrCreateAutoSource(
  admin: SupabaseClient,
  userId: string,
  kind: KbSourceKind,
  label: string
): Promise<string> {
  const { data, error } = await admin
    .from('kb_sources')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', kind)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`getOrCreateAutoSource failed (lookup): ${error.message}`)
  if (data) return (data as { id: string }).id

  const created = await createSource(admin, { userId, kind, label, enabled: true })
  return created.id
}

/**
 * Persist one of a company's own home/about/careers pages. Idempotent via
 * external_id `${companyId}:${page}` — a later research run on the same
 * company REPLACES this page's chunks rather than piling up duplicates.
 * No-ops on blank text (nothing worth storing; upsertDocument would reject an
 * empty document anyway).
 */
export async function ingestCompanyPage(
  admin: SupabaseClient,
  userId: string,
  companyId: string,
  page: CompanyPage,
  text: string
): Promise<void> {
  if (!text.trim()) return
  const sourceId = await getOrCreateAutoSource(admin, userId, 'company_site', 'Company pages')
  await upsertDocument(admin, {
    userId,
    sourceId,
    externalId: `${companyId}:${page}`,
    title: `Company ${page} page`,
    content: text,
    companyId,
  })
}

/**
 * Persist the dossier's summary (AI-synthesized or the Wikipedia-extract
 * fallback — whichever ended up on the company_dossiers row). Idempotent via
 * external_id `${companyId}:dossier`; company_dossiers itself is unaffected —
 * this is a second, searchable copy, not a replacement for the structured row.
 */
export async function ingestDossierSummary(
  admin: SupabaseClient,
  userId: string,
  companyId: string,
  summary: string
): Promise<void> {
  if (!summary.trim()) return
  const sourceId = await getOrCreateAutoSource(admin, userId, 'dossier', 'Company dossiers')
  await upsertDocument(admin, {
    userId,
    sourceId,
    externalId: `${companyId}:dossier`,
    title: 'Company dossier summary',
    content: summary,
    companyId,
  })
}

/**
 * Read back whatever company pages are already on file, reconstructing each
 * one's public URL from `domain` (kb_documents stores the text, not the URL —
 * see ingestCompanyPage). Returns null — "go live-fetch instead" — when
 * nothing is stored yet, or when any stored page is older than
 * STALE_AFTER_MS; a partial-but-fresh set (e.g. a company with no /about page
 * to have ever ingested) is returned as-is rather than forced stale by what
 * was never there.
 *
 * This only ever returns the 3 pages ingestCompanyPage covers — narrower than
 * lib/dossier/sources.ts#fetchCompanyContactPages's 6 paths (also /about-us,
 * /team, /contact). That's the deliberate trade this function exists to make:
 * skip the network entirely when recent research already answered "what do
 * these pages say", accepting the narrower page set in exchange. Absent/stale
 * still falls through to the full 6-path live fetch, so nothing is ever
 * permanently missed.
 */
export async function readFreshCompanyPages(
  admin: SupabaseClient,
  userId: string,
  companyId: string,
  domain: string
): Promise<StoredCompanyPage[] | null> {
  // Inline array literal (self-evidently bounded — exactly the 3 COMPANY_PAGES
  // entries, never per-user data — see lib/supabase/in-scoping-chokepoints.test.ts).
  const { data, error } = await admin
    .from('kb_documents')
    .select('external_id, content, updated_at')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .in('external_id', [`${companyId}:home`, `${companyId}:about`, `${companyId}:careers`])
  if (error) throw new Error(`readFreshCompanyPages failed: ${error.message}`)

  const rows = (data as { external_id: string; content: string; updated_at: string }[]) ?? []
  if (rows.length === 0) return null

  const staleBefore = Date.now() - STALE_AFTER_MS
  if (rows.some((row) => new Date(row.updated_at).getTime() < staleBefore)) return null

  return rows.map((row) => {
    const page = row.external_id.slice(companyId.length + 1)
    const url = page === 'home' ? `https://${domain}` : `https://${domain}/${page}`
    return { url, text: row.content }
  })
}
