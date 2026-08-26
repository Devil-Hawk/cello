// CRUD for public.company_dossiers via a Supabase client.
//
// The table is not in @cello/shared's generated Database type, so this uses an
// untyped client (server client for RLS-scoped reads, or the service-role admin
// client for writes) with the row shape declared here. Upsert-only: the unique
// key is (company_id) and there is intentionally no DELETE policy.

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyId } from '../entities/companies'

const TABLE = 'company_dossiers'

/** likely | unlikely | unknown — always a signal, never a hard claim. */
export type VisaSignal = 'likely' | 'unlikely' | 'unknown'

/**
 * WHY a surviving source is considered relevant to the company — attached so
 * the UI can show its basis and so relevance-filtering can't silently regress:
 *   - 'domain'       HN story whose URL host is the company's own domain
 *   - 'exact-title'  HN story whose TITLE contains a word-boundary, exact
 *                     match of the company name (typo tolerance disabled)
 *   - 'official-site' the company's own home page
 *   - 'careers'      the company's own careers page
 *   - 'wikipedia'    a Wikipedia summary verified to be about this company
 *   - 'github'       the company's public GitHub org profile
 */
export type SourceMatchReason =
  | 'domain'
  | 'exact-title'
  | 'official-site'
  | 'careers'
  | 'wikipedia'
  | 'github'

export interface SourceRef {
  title: string
  url: string
  matchedBy?: SourceMatchReason
}

export interface CompIntel {
  rangeLow: number | null
  rangeHigh: number | null
  /** Human-readable provenance, e.g. "Posted salary ranges". */
  source: string
  confidence: 'high' | 'medium' | 'low'
}

/**
 * WHY `summary` is null — always set alongside a null summary, never left for
 * the UI to guess at. Persisted at generation time so a page load (no fresh
 * generation) can still explain itself honestly:
 *   - 'no-key'             no OpenRouter key was configured when this was generated
 *   - 'no-signals'         a key existed, but nothing was substantial enough to
 *                          feed the model (no Wikipedia page, no readable site text,
 *                          no GitHub org description)
 *   - 'generation-failed'  the model call was attempted and errored (or returned
 *                          an empty summary) — `detail` carries a short, sanitized
 *                          reason, never a raw key or stack trace
 *   - 'stale'              display-only, computed by resolveSummaryUnavailable:
 *                          the row says 'no-key' but the caller has one NOW, so
 *                          this row simply predates it
 */
export type MissingSummaryReason = 'no-key' | 'no-signals' | 'generation-failed' | 'stale'

export interface SummaryStatus {
  reason: MissingSummaryReason
  /** Short, sanitized explanation (e.g. an LLM error message). Never a key. */
  detail?: string
}

export interface DossierSignals {
  funding?: string | null
  headcountTrend?: string | null
  news?: SourceRef[]
  culture?: string | null
  techStack?: string[]
  /** What this company likely wants from a candidate — LLM synthesis only, grounded in the fetched excerpts. */
  whatTheyWant?: string | null
  /** What's genuinely uncertain given the available sources — LLM synthesis only. */
  uncertainty?: string | null
  /** 'ai' when `summary` was synthesized by the model; 'wikipedia' when it's a raw extract used as a fallback (no key, or nothing else synthesizable). Absent when there is no summary. */
  summarySource?: 'ai' | 'wikipedia' | null
  /** Set whenever `summary` is null — see MissingSummaryReason. Never left unexplained. */
  summaryUnavailable?: SummaryStatus | null
  /** Raw, un-normalized signals kept for the no-key (partial) path. */
  raw?: Record<string, unknown>
}

export interface CompanyDossierRow {
  id: string
  company_id: string
  user_id: string
  summary: string | null
  signals: DossierSignals | null
  comp_intel: CompIntel | null
  sponsors_visa: VisaSignal | null
  sources: SourceRef[] | null
  refreshed_at: string
  created_at: string
}

export interface NewDossier {
  company_id: string
  user_id: string
  summary?: string | null
  signals?: DossierSignals | null
  comp_intel?: CompIntel | null
  sponsors_visa?: VisaSignal | null
  sources?: SourceRef[] | null
}

/**
 * Insert-or-update the single dossier for a company. Conflict target is
 * `company_id` (each company belongs to exactly one user, so company_id
 * uniquely determines user_id). Always refreshes `refreshed_at`.
 */
export async function upsertDossier(
  client: SupabaseClient,
  row: NewDossier
): Promise<CompanyDossierRow> {
  const { data, error } = await client
    .from(TABLE)
    .upsert(
      { ...row, refreshed_at: new Date().toISOString() },
      { onConflict: 'company_id' }
    )
    .select('*')
    .single()
  if (error) throw new Error(`upsertDossier failed: ${error.message}`)
  return data as CompanyDossierRow
}

/**
 * Read the current dossier for a company, scoped to the owning user.
 *
 * `companyId` is chased through lib/entities/companies.ts#resolveCompanyId
 * first: a dossier is keyed one-per-company (see upsertDossier's onConflict),
 * so once two companies merge, only the survivor's row is the real one —
 * looking a duplicate up by its own raw id must still find it.
 */
export async function getDossierByCompany(
  client: SupabaseClient,
  userId: string,
  companyId: string
): Promise<CompanyDossierRow | null> {
  const resolvedCompanyId = await resolveCompanyId(client, companyId)
  const { data } = await client
    .from(TABLE)
    .select('*')
    .eq('company_id', resolvedCompanyId)
    .eq('user_id', userId)
    .maybeSingle()
  return (data as CompanyDossierRow | null) ?? null
}

/**
 * Resolve the missing-summary reason as it should be DISPLAYED right now. The
 * persisted reason reflects state at generation time; if the row says
 * 'no-key' but the caller currently has a key configured, the row simply
 * predates that key, so the honest current explanation is 'stale' (a refresh
 * would now produce a real summary), not the stale 'no-key' claim.
 *
 * Rows written before this field existed have no persisted reason at all —
 * for those, the best honest statement we can make is about CURRENT state:
 * 'stale' if a key exists now (refresh may help), 'no-key' if it still doesn't.
 */
export function resolveSummaryUnavailable(
  row: Pick<CompanyDossierRow, 'summary' | 'signals'> | null,
  hasKey: boolean
): SummaryStatus | null {
  if (!row || row.summary) return null
  const stored = row.signals?.summaryUnavailable ?? null
  if (!stored) return hasKey ? { reason: 'stale' } : { reason: 'no-key' }
  if (stored.reason === 'no-key' && hasKey) return { reason: 'stale' }
  return stored
}

/**
 * Same row, with `signals.summaryUnavailable` resolved for display (see
 * resolveSummaryUnavailable) — never mutates the persisted row.
 */
export function withDisplaySummaryStatus(
  row: CompanyDossierRow | null,
  hasKey: boolean
): CompanyDossierRow | null {
  if (!row) return null
  const summaryUnavailable = resolveSummaryUnavailable(row, hasKey)
  return { ...row, signals: { ...(row.signals ?? {}), summaryUnavailable } }
}

/** All dossiers the user owns (used to build the jobs-list visa map). */
export async function listDossiersForUser(
  client: SupabaseClient,
  userId: string
): Promise<CompanyDossierRow[]> {
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('refreshed_at', { ascending: false })
  if (error) throw new Error(`listDossiersForUser failed: ${error.message}`)
  return (data as CompanyDossierRow[]) ?? []
}
