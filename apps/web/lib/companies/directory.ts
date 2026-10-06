// companies.list and companies.search: the employers the directory has verified, and nothing else.
//
// A row is listed once a board was tied to it by evidence (verify-directory.ts). A candidate that is still waiting for
// its turn is shown by search as "Not checked yet" (it has no count and no roles); one that failed is never shown.
// Reads go through the service role after the route has checked who is asking: the table holds public facts only.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeCompanyName } from '../entities/companies'

type Db = SupabaseClient<any, any, any>

export interface DirectoryRow {
  id: string
  name: string
  name_norm: string
  domain: string | null
  logo_url: string | null
  open_count: number | null
  open_count_at: string | null
  ats_provider: string | null
  ats_token: string | null
  careers_url: string | null
  verified_by: string | null
  verified_at: string | null
  source: string
  last_read_at: string | null
  next_read_at: string | null
  read_tier: string | null
  cannot_read_reason: string | null
  failed_reads: number | null
}

/** A candidate Cello knows of and has not checked: shown in search as "Not checked yet", with no count. */
export interface NotChecked {
  id: string
  name: string
  domain: string | null
}

export const LIST_PAGE = 50

/** The verified employers, most open roles first, a page at a time. */
export async function listCompanies(db: Db, opts: { limit?: number; offset?: number } = {}): Promise<DirectoryRow[]> {
  const { data, error } = await db.rpc('list_company_directory', { p_limit: opts.limit ?? LIST_PAGE, p_offset: opts.offset ?? 0 })
  if (error) throw new Error('could not list employers')
  return (data ?? []) as DirectoryRow[]
}

/** Verified employers by name, domain or board token, then pending candidates by name. A query with nothing to match is empty. */
export async function searchCompanies(db: Db, query: string, opts: { limit?: number } = {}): Promise<{ employers: DirectoryRow[]; notChecked: NotChecked[] }> {
  const q = query.trim().slice(0, 120)
  if (!q) return { employers: [], notChecked: [] }
  const { data, error } = await db.rpc('search_company_directory', { p_query: q, p_limit: opts.limit ?? 8 })
  if (error) throw new Error('could not search employers')
  const employers = (data ?? []) as DirectoryRow[]
  // Only a candidate the seed holds and nobody has checked; never a failed one, never a verified one (that is in `employers`).
  const norm = normalizeCompanyName(q)
  let notChecked: NotChecked[] = []
  if (norm.length >= 2) {
    const { data: pending } = await db.from('directory_candidates').select('id, name, domain').eq('state', 'pending').like('name_norm', `${norm.replace(/[%_]/g, '')}%`).limit(5)
    const have = new Set(employers.map((e) => e.name_norm))
    notChecked = ((pending ?? []) as NotChecked[]).filter((p) => !have.has(normalizeCompanyName(p.name)))
  }
  return { employers, notChecked }
}

/** How far the seed's verification has come: "Cello has checked 1,200 employers so far." */
export async function directoryProgress(db: Db): Promise<{ verified: number; pending: number; failed: number }> {
  const { data } = await db.rpc('directory_progress')
  const row = (Array.isArray(data) ? data[0] : data) as { verified?: number; pending?: number; failed?: number } | null
  return { verified: Number(row?.verified ?? 0), pending: Number(row?.pending ?? 0), failed: Number(row?.failed ?? 0) }
}

export async function getEmployer(db: Db, id: string): Promise<DirectoryRow | null> {
  const { data } = await db.from('company_directory').select('*').eq('id', id).not('verified_at', 'is', null).maybeSingle()
  return (data as DirectoryRow | null) ?? null
}
