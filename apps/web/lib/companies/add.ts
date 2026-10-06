// Saving a company the person picked in the Add company dialog. A name or domain
// can already belong to a hidden suggested lead (the sourcer or an old Gmail sync
// wrote it), and that row still owns the unique keys, so a plain insert fails.
// Adding it promotes the lead to a tracked row instead. Either way the row is followed through the
// one writer of that flag (companies_follow, K13), never by a write to the column.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeCompanyName } from '@/lib/entities/companies'
import { isTrackedCompany } from '@/lib/companies/watchlist'

export interface CompanyToAdd {
  name: string
  domain: string | null
  careerUrl: string | null
  logoUrl: string | null
  isDream: boolean
}

export type AddCompanyResult = { id: string; error?: undefined } | { id?: undefined; error: string }

interface ExistingRow {
  id: string
  name: string
  domain: string | null
  metadata: Record<string, unknown> | null
}

async function follow(db: SupabaseClient, userId: string, id: string): Promise<string | null> {
  const { error } = await db.rpc('companies_follow', { p_ids: [id], p_on: true, p_user: userId })
  return error ? error.message : null
}

export async function saveCompany(db: SupabaseClient, userId: string, c: CompanyToAdd): Promise<AddCompanyResult> {
  const nameKey = normalizeCompanyName(c.name)
  const domain = c.domain?.toLowerCase().replace(/^www\./, '') || null
  const match = [nameKey && `name_key.eq.${nameKey}`, domain && `domain.eq.${domain}`].filter(Boolean).join(',')

  let existing: ExistingRow | null = null
  if (match) {
    const { data, error } = await db
      .from('companies')
      .select('id, name, domain, metadata')
      .eq('user_id', userId)
      .or(match)
      .limit(1)
      .maybeSingle()
    if (error) return { error: `Could not check your companies: ${error.message}` }
    existing = data as ExistingRow | null
  }

  // companies.career_url is NOT NULL: '' is the "no career page yet" sentinel, and a
  // bare homepage must never be written here (it fed the HTML-scraper fallback).
  const fields = {
    logo_url: c.logoUrl,
    career_url: c.careerUrl ?? '',
    is_dream_company: c.isDream,
  }

  if (existing) {
    if (isTrackedCompany(existing)) return { error: `You already track ${existing.name}.` }
    const { suggested: _dropped, ...metadata } = existing.metadata ?? {}
    const { error } = await db
      .from('companies')
      .update({ ...fields, domain: domain ?? existing.domain, name_key: nameKey || null, metadata })
      .eq('id', existing.id)
      .eq('user_id', userId)
    if (error) return { error: `Could not add ${c.name}: ${error.message}` }
    const failed = await follow(db, userId, existing.id)
    return failed ? { error: `Could not add ${c.name}: ${failed}` } : { id: existing.id }
  }

  const { data, error } = await db
    .from('companies')
    .insert({ user_id: userId, name: c.name, domain, name_key: nameKey || null, ...fields })
    .select('id')
    .single()
  if (error || !data) return { error: `Could not add ${c.name}: ${error?.message ?? 'no row came back'}` }
  const id = (data as { id: string }).id
  const failed = await follow(db, userId, id)
  return failed ? { error: `Could not add ${c.name}: ${failed}` } : { id }
}
