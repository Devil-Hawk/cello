// Read the two BYOK provider keys this workstream owns — Hunter.io and
// Apollo.io — from the SAME encrypted slot every other opt-in key lives in:
// profiles.preferences.api_keys. Deliberately does NOT go through
// lib/harness/keys.ts loadApiKeys / lib/apikeys.ts getDecryptedApiKeys: those
// two only decrypt the three LLM provider keys (openai/anthropic/openrouter)
// — extending their provider loop belongs to whichever workstream owns those
// shared files, not this one. This mirrors the exact precedent already set by
// lib/outreach/config.ts's readOutreachConfig() for the 'hunter' slot.
//
// Absent key => the corresponding field is undefined => lib/contacts/sources.ts
// skips that provider SILENTLY (never an error) and the free path is the
// entire result. Framework-free (no next/* imports) so it works from a
// request route AND from the harness/cron context.

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, isEncrypted } from '@/lib/crypto'

export interface ContactProviderKeys {
  hunter?: string
  apollo?: string
}

function decryptMaybe(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    return isEncrypted(value) ? decrypt(value) : value
  } catch {
    return undefined
  }
}

/** Accepts any Supabase client (cookie-scoped OR service-role admin) — only ever reads one JSON column. */
export async function readContactProviderKeys(client: SupabaseClient, userId: string): Promise<ContactProviderKeys> {
  const { data } = await client.from('profiles').select('preferences').eq('id', userId).single()
  const preferences = ((data as { preferences?: unknown } | null)?.preferences || {}) as Record<string, unknown>
  const apiKeys = (preferences.api_keys || {}) as Record<string, unknown>
  return {
    hunter: decryptMaybe(apiKeys.hunter),
    apollo: decryptMaybe(apiKeys.apollo),
  }
}
