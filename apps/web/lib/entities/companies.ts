// Company identity — THE single accessor for resolving, matching, and
// merging companies. Every aggregate read keyed by a company id (a count, a
// dossier lookup, anything that answers "what does this company look like")
// must chase merges through resolveCompanyId first, because a merge is pure
// INDIRECTION (see the migration's header): mergeCompanies never rewrites a
// job/contact/dossier row's company_id, it only sets the loser's
// canonical_id. A raw `.eq('company_id', someId)` is therefore only ever
// correct for someId's OWN rows — a caller answering a question about "this
// company" (which may since have been declared a duplicate) needs the
// canonical id, and this module is the only place that logic lives.
//
// See supabase/migrations/20260816000002_company_identity.sql for the schema
// this operates on (companies.name_key/canonical_id, company_merge_candidates)
// and lib/entities/companies-chokepoint.test.ts for the source-level scan that
// pins feature modules to calling through here.

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Normalize a company name for identity matching (lowercase, strip legal
 * suffixes/punctuation) — the source of companies.name_key. Moved here from
 * lib/sources/index.ts (which re-exports it for backward compatibility) so
 * this module, the identity chokepoint, does not depend on the ingestion
 * module that now depends on IT for resolveCompany/mergeCompanies.
 */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|gmbh|corp|co|company|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface ResolvedCompany {
  id: string
  name: string
  domain: string | null
}

interface CompanyRow {
  id: string
  name: string
  domain: string | null
  canonical_id: string | null
}

/**
 * Chase a company id through ONE hop of canonical_id and return the id a
 * caller should actually query against.
 *
 * ONE HOP IS ENOUGH: mergeCompanies collapses chains at merge time (absorbing
 * B into survivor A also repoints anything already pointing at B directly
 * onto A), so no row's canonical_id ever points at another row that itself
 * has a canonical_id. A second lookup here would only ever confirm that.
 *
 * `id` not found (bad/deleted id) or carrying no canonical_id (the common
 * case: most companies are never merged) resolves to itself — this never
 * throws, matching the "degrade gracefully" idiom the rest of this codebase's
 * company-scoped reads already use (see e.g. app/api/contacts/source's
 * isMissingColumnError fallback).
 */
export async function resolveCompanyId(db: SupabaseClient, id: string): Promise<string> {
  const { data } = await db.from('companies').select('canonical_id').eq('id', id).maybeSingle()
  return (data as { canonical_id: string | null } | null)?.canonical_id ?? id
}

/**
 * Find an existing company by exact name_key or domain match, chased through
 * one hop of canonical_id so the row returned is always the current survivor
 * — never a duplicate a caller would go on to attach new data to. Returns
 * null when nothing matches (caller's job to create-if-absent).
 */
export async function resolveCompany(
  db: SupabaseClient,
  userId: string,
  match: { name?: string; domain?: string }
): Promise<ResolvedCompany | null> {
  const nameKey = match.name ? normalizeCompanyName(match.name) : ''
  const domain = match.domain?.toLowerCase().replace(/^www\./, '') || ''
  if (!nameKey && !domain) return null

  const orParts = [nameKey && `name_key.eq.${nameKey}`, domain && `domain.eq.${domain}`].filter(Boolean) as string[]
  const { data } = await db
    .from('companies')
    .select('id, name, domain, canonical_id')
    .eq('user_id', userId)
    .or(orParts.join(','))
    .limit(1)
    .maybeSingle()
  const row = data as CompanyRow | null
  if (!row) return null
  if (!row.canonical_id) return { id: row.id, name: row.name, domain: row.domain }

  const { data: survivor } = await db
    .from('companies')
    .select('id, name, domain')
    .eq('id', row.canonical_id)
    .maybeSingle()
  const s = survivor as ResolvedCompany | null
  // The FK guarantees row.canonical_id references a real company, so `s` is
  // never actually null — this fallback only guards a race with a concurrent
  // delete between the two selects.
  return s ?? { id: row.id, name: row.name, domain: row.domain }
}

/**
 * Merge `duplicateId` into `survivorId`: points the duplicate's canonical_id
 * at the survivor (chased through one hop, so survivorId itself being a
 * duplicate can never start a chain) and collapses any row that already
 * pointed at the duplicate onto the same final survivor — the chain-collapse
 * that keeps resolveCompanyId's one-hop invariant true forever, not just
 * immediately after this call.
 *
 * Writes/updates the audit trail row in company_merge_candidates regardless
 * of whether one already existed (a same-domain auto-merge from
 * scanMergeCandidates may never have had a 'pending' row to update).
 */
export async function mergeCompanies(
  db: SupabaseClient,
  userId: string,
  survivorId: string,
  duplicateId: string
): Promise<void> {
  if (survivorId === duplicateId) {
    throw new Error('mergeCompanies: survivor and duplicate are the same company')
  }
  const finalSurvivorId = await resolveCompanyId(db, survivorId)
  if (finalSurvivorId === duplicateId) {
    throw new Error('mergeCompanies: duplicate is already the survivor of this pair')
  }

  const { error } = await db
    .from('companies')
    .update({ canonical_id: finalSurvivorId })
    .eq('id', duplicateId)
    .eq('user_id', userId)
  if (error) throw new Error(`mergeCompanies: ${error.message}`)

  const { error: collapseError } = await db
    .from('companies')
    .update({ canonical_id: finalSurvivorId })
    .eq('canonical_id', duplicateId)
    .eq('user_id', userId)
  if (collapseError) throw new Error(`mergeCompanies: chain collapse failed: ${collapseError.message}`)

  // Race-safe by construction, not by check-then-write: `idx_merge_candidates
  // _pair_unique` (user_id, company_a, company_b) backs the upsert, so a
  // concurrent mergeCompanies for the same pair either wins the insert (its
  // row's original reason/score survive — ignoreDuplicates never overwrites
  // them) or loses it silently; both callers then run the same unconditional
  // UPDATE and converge on status 'merged'. This also removes the
  // .maybeSingle() this replaced, which threw for real once two rows for one
  // pair ever existed.
  const [a, b] = [finalSurvivorId, duplicateId].sort()
  const { error: seedError } = await db.from('company_merge_candidates').upsert(
    { user_id: userId, company_a: a, company_b: b, score: 1, reason: 'merged directly (no prior candidate row)', status: 'merged' },
    { onConflict: 'user_id,company_a,company_b', ignoreDuplicates: true }
  )
  if (seedError) throw new Error(`mergeCompanies: record audit trail failed: ${seedError.message}`)
  const { error: statusError } = await db
    .from('company_merge_candidates')
    .update({ status: 'merged' })
    .eq('user_id', userId)
    .eq('company_a', a)
    .eq('company_b', b)
  if (statusError) throw new Error(`mergeCompanies: record audit trail failed: ${statusError.message}`)
}

/** Clear a merge: the company goes back to being its own survivor. */
export async function unmergeCompany(db: SupabaseClient, userId: string, companyId: string): Promise<void> {
  const { error } = await db
    .from('companies')
    .update({ canonical_id: null })
    .eq('id', companyId)
    .eq('user_id', userId)
  if (error) throw new Error(`unmergeCompany: ${error.message}`)
}

export interface MergeScanResult {
  /** Same-domain pairs merged automatically this scan. */
  merged: number
  /** Fuzzy name matches newly flagged for human review this scan. */
  pending: number
}

/**
 * Find and record merge candidates for a user's tracked companies.
 *
 *  - Same-domain pairs auto-merge (via mergeCompanies) — domain identity is a
 *    strong signal ONLY because employerDomainFromUrl (lib/sources/util.ts)
 *    excludes aggregator hosts via SOURCE_FETCH_HOSTS, so two companies
 *    genuinely sharing a real employer domain are the same employer, not two
 *    unrelated companies whose jobs both surfaced through the same job board.
 *  - Fuzzy name matches (pg_trgm similarity > 0.6 on name_key, computed
 *    DB-side by find_company_merge_candidates) are NEVER auto-applied — each
 *    becomes a 'pending' row for a human to confirm or reject.
 *
 * Idempotent: a pair already recorded in company_merge_candidates (any
 * status — pending, merged, or a human's prior rejection) is never
 * re-proposed.
 */
export async function scanMergeCandidates(db: SupabaseClient, userId: string): Promise<MergeScanResult> {
  const existingPairs = await loadKnownPairs(db, userId)

  const { data: survivors, error } = await db
    .from('companies')
    .select('id, domain')
    .eq('user_id', userId)
    .is('canonical_id', null)
    .not('domain', 'is', null)
  if (error) throw new Error(`scanMergeCandidates: load companies failed: ${error.message}`)

  const byDomain = groupByDomain(survivors ?? [])

  let merged = 0
  for (const ids of byDomain.values()) {
    if (ids.length < 2) continue
    const [survivorId, ...dupeIds] = [...ids].sort()
    for (const dupeId of dupeIds) {
      const pairKey = pairOf(survivorId, dupeId)
      if (existingPairs.has(pairKey)) continue
      await mergeCompanies(db, userId, survivorId, dupeId)
      existingPairs.add(pairKey)
      merged++
    }
  }

  const { data: fuzzy, error: rpcError } = await db.rpc('find_company_merge_candidates', {
    p_user_id: userId,
    p_threshold: 0.6,
  })
  if (rpcError) throw new Error(`scanMergeCandidates: trgm scan failed: ${rpcError.message}`)

  let pending = 0
  for (const r of (fuzzy ?? []) as { company_a: string; company_b: string; score: number }[]) {
    const pairKey = pairOf(r.company_a, r.company_b)
    if (existingPairs.has(pairKey)) continue
    const [a, b] = [r.company_a, r.company_b].sort()
    // ignoreDuplicates + idx_merge_candidates_pair_unique: two overlapping
    // scans proposing the same pair converge on one row instead of racing a
    // plain insert into a unique-constraint error.
    const { error: insertError } = await db.from('company_merge_candidates').upsert(
      { user_id: userId, company_a: a, company_b: b, score: r.score, reason: `name similarity ${r.score.toFixed(2)}`, status: 'pending' },
      { onConflict: 'user_id,company_a,company_b', ignoreDuplicates: true }
    )
    if (insertError) throw new Error(`scanMergeCandidates: record candidate failed: ${insertError.message}`)
    existingPairs.add(pairKey)
    pending++
  }

  return { merged, pending }
}

/**
 * Tracked job count for a company — a cheap size proxy (this schema stores no
 * headcount; see lib/contacts/relevance.ts's own header for the identical
 * proxy reasoning), not a live ATS pull. Moved here from lib/context/
 * assemble.ts#trackedRoleCount (langgraph port Step 6, the reward-loop
 * distiller) so buildMatchContext and lib/graph/distill.ts share ONE
 * accessor instead of two copies of the same count query — callers pass an
 * already-resolved id (resolveCompanyId first) if they need the canonical
 * company's count, not a duplicate's.
 */
export async function trackedRoleCount(db: SupabaseClient, companyId: string): Promise<number> {
  const { count, error } = await db.from('jobs').select('id', { count: 'exact', head: true }).eq('company_id', companyId)
  if (error) {
    console.error(`[entities] trackedRoleCount failed for company=${companyId}: ${error.message}`)
    return 0
  }
  return count ?? 0
}

/** Order-independent key for a company pair — shared with scripts/backfill-company-identity.ts. */
export function pairOf(a: string, b: string): string {
  return [a, b].sort().join('::')
}

/** Group companies by (lowercased) domain — shared with scripts/backfill-company-identity.ts. */
export function groupByDomain(companies: { id: string; domain: string }[]): Map<string, string[]> {
  const byDomain = new Map<string, string[]>()
  for (const c of companies) {
    const key = c.domain.toLowerCase()
    if (!byDomain.has(key)) byDomain.set(key, [])
    byDomain.get(key)!.push(c.id)
  }
  return byDomain
}

async function loadKnownPairs(db: SupabaseClient, userId: string): Promise<Set<string>> {
  const { data, error } = await db
    .from('company_merge_candidates')
    .select('company_a, company_b')
    .eq('user_id', userId)
  if (error) throw new Error(`scanMergeCandidates: load known pairs failed: ${error.message}`)
  return new Set(
    ((data ?? []) as { company_a: string; company_b: string }[]).map((r) => pairOf(r.company_a, r.company_b))
  )
}
