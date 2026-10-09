// Reading and acting on stored suggestions. Reads use the person's own client
// (the owner select policy fences them); writes use the service role with an
// explicit user id filter, because the tables have no write policy.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdminClient } from '../harness/types'
import { addCompany, type AddFailure, type AddResult as Added } from './add-link'
import type { Offer } from './verify-directory'
import { hasRoleSignal } from './refresh'
import type { DismissReason, Suggestion, SuggestionsResponse } from './types'

const MAX_ROWS = 30

interface SuggestionRow {
  id: string
  name: string
  domain: string | null
  logo_url: string | null
  tier: 1 | 2 | 3 | 4
  rank: number
  reason: string
  source_url: string
  source_label: string
  signals: Suggestion['signals'] | null
  ats: Suggestion['ats']
  status: Suggestion['status']
  company_key: string
  company_id: string | null
}

interface StateRow {
  status: 'ok' | 'partial' | 'failed' | 'needs_targeting'
  computed_at: string | null
  next_refresh_at: string | null
}

function toSuggestion(r: SuggestionRow): Suggestion {
  return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    logoUrl: r.logo_url,
    tier: r.tier,
    rank: r.rank,
    reason: r.reason,
    sourceUrl: r.source_url,
    sourceLabel: r.source_label,
    signals: r.signals ?? [],
    ats: r.ats,
    status: r.status,
  }
}

export interface ProfileFacts {
  resume_text: string | null
  preferences: unknown
}

/** What the Suggested tab shows. Never computes: it reads what the cron stored. */
export async function readSuggestions(db: SupabaseClient, userId: string, profile: ProfileFacts): Promise<SuggestionsResponse> {
  const { data: state } = await db
    .from('company_suggestion_state')
    .select('status, computed_at, next_refresh_at')
    .eq('user_id', userId)
    .maybeSingle()
  const { data: rows } = await db
    .from('company_suggestions')
    .select('id, name, domain, logo_url, tier, rank, reason, source_url, source_label, signals, ats, status, company_key, company_id')
    .eq('user_id', userId)
    .eq('status', 'open')
    .order('rank', { ascending: true })
    .limit(MAX_ROWS)
  const s = state as StateRow | null
  const open = ((rows as SuggestionRow[] | null) ?? []).map(toSuggestion)

  if (!hasRoleSignal(profile)) {
    return { status: 'needs_targeting', refresh: { state: null, computedAt: null, nextRefreshAt: null }, suggestions: [] }
  }
  // needs_targeting in the state row is stale once the person has a role signal.
  const refreshState = s && s.status !== 'needs_targeting' ? s.status : null
  if (!s || s.status === 'needs_targeting' || (!s.computed_at && open.length === 0)) {
    return { status: 'not_built', refresh: { state: refreshState, computedAt: null, nextRefreshAt: s?.next_refresh_at ?? null }, suggestions: [] }
  }
  return {
    status: 'ready',
    refresh: { state: refreshState, computedAt: s.computed_at, nextRefreshAt: s.next_refresh_at },
    suggestions: open,
  }
}

export type SuggestionAction =
  | { action: 'add'; dream?: boolean }
  | { action: 'dismiss'; reason?: DismissReason }
  | { action: 'undo' }

/** What adding a suggestion came to, in the shape the Companies page already reads. */
export interface AddedCompany {
  companyId: string
  outcome: 'added' | 'already_watching'
  name: string
  openRoles: number | null
}

export type ActResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; error: 'not_dismissed' }
  /** The employer could not be verified and followed: why, in one line, and what Cello found instead. The suggestion stays open. */
  | { kind: 'not_added'; reason: AddFailure; line: string; offers: Offer[] }
  | { kind: 'ok'; status: Suggestion['status']; added?: AddedCompany }

/** The directory's id for the employer a suggestion's key names (its domain, its board, or its one verified name), or null. */
async function employerIdOf(admin: AdminClient, key: string): Promise<string | null> {
  const verified = () => admin.from('company_directory').select('id').not('verified_at', 'is', null)
  if (key.startsWith('ats:')) {
    const [, provider, token] = key.split(':')
    const { data } = await verified().eq('ats_provider', provider).eq('ats_token', token).maybeSingle()
    return (data as { id: string } | null)?.id ?? null
  }
  if (key.startsWith('name:')) {
    const { data } = await verified().eq('name_norm', key.slice(5)).limit(2)
    const rows = (data ?? []) as { id: string }[]
    return rows.length === 1 ? rows[0].id : null
  }
  const { data } = await verified().eq('domain', key).maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

/**
 * Add, dismiss or undo one suggestion. A missing row, a malformed id and
 * another person's row all answer not_found. Adding goes through companies.add
 * (add-link.ts), so the verifier decides whose board it is, then records the company on the row.
 */
export async function actOnSuggestion(args: {
  db: SupabaseClient
  admin: AdminClient
  userId: string
  id: string
  act: SuggestionAction
}): Promise<ActResult> {
  const { db, admin, userId, id, act } = args
  const { data } = await db
    .from('company_suggestions')
    .select('id, name, domain, logo_url, status, company_key')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  const row = data as Pick<SuggestionRow, 'id' | 'name' | 'domain' | 'logo_url' | 'status' | 'company_key'> | null
  if (!row) return { kind: 'not_found' }

  const write = async (patch: Record<string, unknown>) => {
    const { error } = await admin.from('company_suggestions').update(patch).eq('id', id).eq('user_id', userId)
    if (error) throw new Error(`company_suggestions update: ${error.message}`)
  }
  const now = new Date().toISOString()

  if (act.action === 'add') {
    // A verified employer is followed as it is. Any other is checked now through its own site; a name is never enough.
    const employerId = await employerIdOf(admin, row.company_key)
    const by = employerId ? { employerId } : row.domain ? { link: row.domain } : null
    if (!by) return { kind: 'not_added', reason: 'no_board', line: 'Cello found no website for this company. Paste its careers page.', offers: [] }
    const result: Added = await addCompany(admin, userId, by, undefined, { dream: act.dream })
    if (!result.ok) return { kind: 'not_added', reason: result.reason, line: result.line, offers: result.offers }
    await write({ status: 'added', company_id: result.companyId, acted_at: now, dismiss_reason: null })
    return {
      kind: 'ok',
      status: 'added',
      added: { companyId: result.companyId, outcome: result.already ? 'already_watching' : 'added', name: result.employer.name, openRoles: result.employer.openCount },
    }
  }
  if (act.action === 'dismiss') {
    await write({ status: 'dismissed', dismiss_reason: act.reason ?? null, acted_at: now })
    return { kind: 'ok', status: 'dismissed' }
  }
  if (row.status !== 'dismissed') return { kind: 'conflict', error: 'not_dismissed' }
  await write({ status: 'open', dismiss_reason: null, acted_at: null })
  return { kind: 'ok', status: 'open' }
}
