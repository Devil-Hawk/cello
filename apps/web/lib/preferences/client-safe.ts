// Client-safe projection of profiles.preferences.
//
// WHY THIS EXISTS
//   preferences is one jsonb column carrying everything the account owns:
//   budget, targeting, digest settings — and also api_keys (ciphertext for
//   every LLM/search provider) and autopilot.atsKeys (an ATS board password,
//   never encrypted by any writer, per the secret-handling audit that found
//   this). PostgREST cannot project a jsonb column — `select('preferences')`
//   always returns the WHOLE thing — so a 'use client' component reading it
//   for one harmless field (a budget summary, a gmail sync timestamp) put
//   every secret alongside it into ordinary browser JS memory on every page
//   load. That is reachable by devtools, a malicious extension, a compromised
//   dependency, or any future XSS — not just by the account owner it belongs
//   to.
//
// THE FIX
//   Never call supabase.from('profiles').select('preferences') from a
//   'use client' component. Call fetchClientSafePreferences() instead, which
//   calls public.get_client_safe_preferences() — a SECURITY DEFINER Postgres
//   function (supabase/migrations/20260803000005_profiles_column_privileges.sql)
//   that builds and returns a FIXED, enumerable set of keys. api_keys,
//   atsKeys, provider, and gmail_permissions are not in that set — there is
//   no code path in this file, or in the SQL function it calls, that can leak
//   them, because neither one ever touches them at all.
//
// SHAPE DELIBERATELY MIRRORS RAW preferences so this drops straight into the
// existing tolerant parsers (lib/targeting.ts resolveTargeting,
// lib/targeting/titles.ts resolveTargetTitles, and each page's own inline
// budget/gmail_sync/outreach reads) with zero changes to them — those already
// treat their input as "maybe missing, maybe malformed", which is exactly
// what a jsonb null-propagated field looks like.
//
// WHAT THIS DOES NOT CLOSE — see the migration's own header for the full
// accounting: `authenticated` (a signed-in browser calling PostgREST
// directly, bypassing this file entirely) still has raw column-level
// SELECT/UPDATE on preferences today, because ~20 server routes outside this
// task's ownership still read/write it through the same user-scoped client a
// browser uses. This file makes the CORRECT path narrow; it cannot make the
// raw column stop existing.

import type { SupabaseClient } from '@supabase/supabase-js'

/** Name of the SECURITY DEFINER function this module calls. Single source of
 *  truth so the RPC name only needs to change in one place if it ever does. */
export const CLIENT_SAFE_PREFERENCES_RPC = 'get_client_safe_preferences'

/** Name of the onboarding-only narrow write RPC. See onboarding/page.tsx. */
export const SET_ONBOARDING_PREFERENCES_RPC = 'set_onboarding_preferences'

export interface ClientSafeBudget {
  spentUsd?: number
  monthlyUsd?: number
  periodStart?: string
}

export interface ClientSafeOutreach {
  autoSend?: boolean
  dailyCap?: number
}

export interface ClientSafeGmailSync {
  lastSyncDate?: string
}

/**
 * Exactly what get_client_safe_preferences() can return — see that
 * function's own comment for the field-by-field reasoning on what is in this
 * set and, more importantly, what is deliberately not.
 */
export interface ClientSafePreferences {
  budget?: ClientSafeBudget
  gmail_sync?: ClientSafeGmailSync
  autoSubmit?: boolean
  autoApply?: boolean
  outreach?: ClientSafeOutreach
  matchThreshold?: number
  /**
   * When the user finished onboarding, or absent if they never have.
   *
   * Carried so app/(app)/layout.tsx — which wraps the whole (app) route group
   * and therefore runs on EVERY authenticated page load — can make its
   * first-login decision without reading the raw preferences column.
   */
  onboardedAt?: string | null
  /**
   * Untyped on purpose: pass this straight to resolveTargeting()/
   * resolveTargetTitles() (lib/targeting.ts / lib/targeting/titles.ts), which
   * already own the tolerant parsing contract for this shape. Re-typing it
   * here would just be a second definition to keep in sync with theirs.
   */
  targeting?: unknown
}

/**
 * Fetch the caller's own safe preference projection.
 *
 * @param client an untyped SupabaseClient — @cello/shared's generated
 *   Database type does not (yet) know about this RPC (its `Functions` map is
 *   empty; see packages/shared/src/types/database.ts), so a
 *   `SupabaseClient<Database>` cannot call `.rpc()` on it and typecheck.
 *   Cast at the call site the same way jobs/page.tsx already does for
 *   untyped tables: `supabase as unknown as SupabaseClient`. Mirrors
 *   lib/kb/store.ts's searchKb(), which takes the same untyped parameter for
 *   the same reason.
 *
 * Never throws — a failed call (network error, not signed in, RPC missing on
 * a database that has not run the migration yet) degrades to null, the same
 * "nothing configured yet" state every caller already handles for a missing
 * profiles row.
 */
export async function fetchClientSafePreferences(
  client: SupabaseClient
): Promise<ClientSafePreferences | null> {
  const { data, error } = await client.rpc(CLIENT_SAFE_PREFERENCES_RPC)
  if (error) {
    console.error('[preferences] get_client_safe_preferences RPC failed:', error)
    return null
  }
  return (data ?? null) as ClientSafePreferences | null
}
