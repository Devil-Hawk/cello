// The day's free model calls, counted once for everything that uses the platform's free key.
//
// OpenRouter allows a free account about 1,000 requests a day, shared by every path that calls a free model:
// the typing step, the judge, ingestion and the agents. Every one of them already writes the spend ledger
// (llm_spend, rung R3, one row for each model tried), so the ledger is the one count; there is no second
// counter. A row the provider refused (a 429 or a 404, which settle with failed_status) used no call and is not
// counted; a row with no failure status is, which includes a call that timed out (it may have been served).
//
// The day is the UTC calendar day, not a rolling 24 hours, so it resets when the provider's quota does.
//
// PR 4's judge must use this helper for its budget: the judge's share is the remainder of
// freeCallsLeftToday(), never a second ledger or a fixed number of its own.

import type { SupabaseClient } from '@supabase/supabase-js'

type Db = SupabaseClient<any, any, any>

/** What a free account allows in a day; FREE_DAILY_CALLS overrides it. */
export const FREE_DAILY_CALLS_DEFAULT = 1000
/** The most calls the typing step takes in a slice, and the share of what is left it may take. */
export const TYPING_MAX_CALLS = 100
export const TYPING_SHARE = 0.2

export function freeDailyCalls(env: string | undefined = process.env.FREE_DAILY_CALLS): number {
  const n = Number(env)
  return Number.isInteger(n) && n > 0 ? n : FREE_DAILY_CALLS_DEFAULT
}

/** Free calls made so far this UTC day, from the spend ledger; throws when the ledger cannot be read, so a caller stops. */
export async function freeCallsToday(db: Db, now: () => number = Date.now): Promise<number> {
  const t = new Date(now())
  const dayStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())).toISOString()
  const { count, error } = await db.from('llm_spend').select('id', { count: 'exact', head: true }).eq('rung', 'R3').is('failed_status', null).gte('created_at', dayStart)
  if (error) throw new Error('count_free_calls')
  return count ?? 0
}

export async function freeCallsLeftToday(db: Db, now?: () => number): Promise<number> {
  return Math.max(0, freeDailyCalls() - (await freeCallsToday(db, now)))
}

/** The calls the typing step may make in a slice: at most 100 and a fifth of what is left, so the judge keeps the rest. */
export const typingCalls = (left: number): number => Math.min(TYPING_MAX_CALLS, Math.floor(left * TYPING_SHARE))
