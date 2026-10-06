// lane-stub: K13 followCompanies
//
// The one way this page follows, stops following and pins. It has the signature of pipeline's
// lib/companies/watchlist.ts followCompanies (K13, `companies_follow`), so the import switches to
// '@/lib/companies/watchlist' the moment K13 is on the base and this file is deleted. Until then it
// writes through the session client, so row level security still fences it to the person's own rows.
// Pin only on a followed row, at most 5 pins, then one update.

import type { SupabaseClient } from '@supabase/supabase-js'
import { PIN_LIMIT, PIN_NEEDS_FOLLOW } from '@/components/companies/logic'

type Db = SupabaseClient<any, any, any>

export type FollowResult = { ok: true; changed: number } | { ok: false; sentence: string }

const MAX_PINS = 5
const SAVE_FAILED = 'Could not save that. Try again.'

export async function followCompanies(db: Db, userId: string, ids: string[], change: { follow?: boolean; pin?: boolean }): Promise<FollowResult> {
  const target = ids.slice(0, 50)
  if (target.length === 0 || (change.follow === undefined && change.pin === undefined)) return { ok: true, changed: 0 }

  if (change.pin === true) {
    const { data, error } = await db.from('companies').select('id, watching, is_dream_company').eq('user_id', userId).in('id', ids.slice(0, 50))
    if (error) return { ok: false, sentence: SAVE_FAILED }
    const rows = (data ?? []) as { id: string; watching: boolean; is_dream_company: boolean }[]
    if (rows.some((r) => !r.watching && change.follow !== true)) return { ok: false, sentence: PIN_NEEDS_FOLLOW }
    const { count } = await db.from('companies').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('watching', true).eq('is_dream_company', true)
    const adding = rows.filter((r) => !r.is_dream_company).length
    if ((count ?? 0) + adding > MAX_PINS) return { ok: false, sentence: PIN_LIMIT }
  }

  // Stopping a follow also takes the pin off: a pin is only ever on a followed company.
  const patch = {
    ...(change.follow !== undefined ? { watching: change.follow } : {}),
    ...(change.pin !== undefined ? { is_dream_company: change.pin } : {}),
    ...(change.follow === false ? { is_dream_company: false } : {}),
  }
  const { data, error } = await db.from('companies').update(patch).eq('user_id', userId).in('id', ids.slice(0, 50)).select('id')
  if (error) return { ok: false, sentence: SAVE_FAILED }
  return { ok: true, changed: (data ?? []).length }
}
