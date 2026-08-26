// Read a user's outreach config from profiles.preferences (single fetch).
//
// Crypto-only (no openai / next imports) so it is safe to call from the harness
// enricher (cron context) as well as request handlers. Keys live encrypted at
// profiles.preferences.api_keys.{openrouter,hunter} — NOT profiles.api_keys,
// which does not exist in prod. Never log or return raw key values elsewhere.
//
// ---------------------------------------------------------------------------
// THIS IS A DEMO CHOKEPOINT TOO — it was the third way to reach a paid model
// ---------------------------------------------------------------------------
// lib/harness/keys.ts's header used to claim the two key loaders were a narrow
// waist that "nothing calls a provider without first asking". This file was the
// counterexample: it reads profiles.preferences directly and hands back a
// decrypted OpenRouter key, and app/api/outreach/draft and
// app/api/outreach/follow-up turn that key into a real model call through
// makeLlmRunner. Neither loader was on that path, so an EXPIRED demo could
// still spend — the deadline was enforced everywhere except the one route pair
// an inbound message can trigger.
//
// Rather than add a fourth copy of the policy, this file now ends on exactly
// the function both loaders end on: applyDemoKeyGuards. Same columns, same
// refusal, same spend attribution. lib/access/demo-chokepoints.test.ts pins the
// set of key sources at three and asserts each one runs it.
//
// IT THROWS NOW, WHERE IT USED TO DEGRADE. Past the 72 hours — or on a profile
// that cannot be read at all — this raises DemoAccessError instead of returning
// an empty config. Returning no key would look tidier and would still prevent
// the spend, but it would present an expired demo with the deterministic
// template fallback as though the model had simply declined, and it would hide
// an unreadable profile from the owner entirely. Callers that want a friendly
// 403 should catch DemoAccessError and render `err.gate.message`, the way
// app/api/outreach/send/route.ts renders demoSendGate's.

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, isEncrypted } from '@/lib/crypto'
import { applyDemoKeyGuards, readProfileForDemoGuards, type KeyLoaderProfileRow } from '@/lib/harness/keys'
import { resolveOutreachPreferences, type OutreachPreferences } from './types'

export interface OutreachConfig {
  prefs: OutreachPreferences
  openrouterKey?: string
  hunterKey?: string
  /**
   * Whose ledger a model call made with `openrouterKey` must be charged to,
   * after the demo guards have had their say.
   *
   * It is the value applyDemoKeyGuards settled on, which for a demo profile is
   * the demo's own id no matter what was asked for — see demoSafeApiKeys.
   * Prefer `config.userId` over re-deriving the id at the call site: today the
   * outreach routes pass their own `user.id`, which is the same value for a
   * cookie-scoped session, but "the same value today" is not the same thing as
   * "the value the guards approved".
   */
  userId: string
}

function decryptMaybe(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    return isEncrypted(value) ? decrypt(value) : value
  } catch {
    return undefined
  }
}

/**
 * Accept any Supabase client (server OR admin); we only read one profile row.
 *
 * @throws DemoAccessError when the caller is a demo whose 72 hours are up, or
 *         whose profile cannot be read at all. See the file header.
 */
export async function readOutreachConfig(
  client: SupabaseClient,
  userId: string
): Promise<OutreachConfig> {
  // The shared column list, not a hand-written one: a copy that selected
  // `preferences` and forgot `is_demo` would read `undefined`, and `undefined`
  // is indistinguishable from "not a demo" to anyone not looking for the
  // difference. One constant means that mistake can only be made once.
  // Tolerant of a pre-migration schema — see readProfileForDemoGuards. Without
  // it a missing is_demo column failed this select whole and took the outreach
  // model key down with it.
  const { row: data, error } = await readProfileForDemoGuards(client, userId)

  if (error) {
    // Loud, and without key material — same reasoning as the two loaders: an
    // unreadable profile refuses below, so naming the cause here is the
    // difference between a five-second diagnosis and a mystery outage. The
    // likeliest cause is a schema that predates the access-codes migration,
    // which fails the whole SELECT on the is_demo column.
    console.error(`outreach/config: profile read failed for ${userId} — ${error.message}`)
  }

  const row = (data ?? null) as KeyLoaderProfileRow | null
  const preferences = ((row?.preferences as Record<string, unknown> | null) || {}) as Record<string, unknown>
  const apiKeys = (preferences.api_keys || {}) as Record<string, unknown>

  // The demo guards run on the OpenRouter slot because that is the one that
  // costs money per token. They refuse the whole read for an expired demo, so
  // the Hunter key below is gated by the same deadline even though it is not a
  // model key.
  const guarded = applyDemoKeyGuards(
    { openrouter: decryptMaybe(apiKeys.openrouter), userId },
    row,
    userId
  )

  return {
    prefs: resolveOutreachPreferences(preferences.outreach),
    openrouterKey: guarded.openrouter,
    hunterKey: decryptMaybe(apiKeys.hunter),
    // Non-null: applyDemoKeyGuards always sets it (demoSafeApiKeys for a demo,
    // the `userId` passed in otherwise) and throws rather than returning
    // without one.
    userId: guarded.userId ?? userId,
  }
}
