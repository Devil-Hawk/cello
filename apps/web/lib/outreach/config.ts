// Read a user's outreach config from profiles.preferences (single fetch).
//
// Crypto-only (no openai / next imports) so it is safe to call from the harness
// enricher (cron context) as well as request handlers. Keys live encrypted at
// profiles.preferences.api_keys.{openrouter,hunter} — NOT profiles.api_keys,
// which does not exist in prod. Never log or return raw key values elsewhere.

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, isEncrypted } from '@/lib/crypto'
import { resolveOutreachPreferences, type OutreachPreferences } from './types'

export interface OutreachConfig {
  prefs: OutreachPreferences
  openrouterKey?: string
  hunterKey?: string
}

function decryptMaybe(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    return isEncrypted(value) ? decrypt(value) : value
  } catch {
    return undefined
  }
}

// Accept any Supabase client (server OR admin); we only read one JSON column.
export async function readOutreachConfig(
  client: SupabaseClient,
  userId: string
): Promise<OutreachConfig> {
  const { data } = await client.from('profiles').select('preferences').eq('id', userId).single()
  const row = data as { preferences?: unknown } | null
  const preferences = ((row?.preferences as Record<string, unknown> | null) || {}) as Record<string, unknown>
  const apiKeys = (preferences.api_keys || {}) as Record<string, unknown>

  return {
    prefs: resolveOutreachPreferences(preferences.outreach),
    openrouterKey: decryptMaybe(apiKeys.openrouter),
    hunterKey: decryptMaybe(apiKeys.hunter),
  }
}
