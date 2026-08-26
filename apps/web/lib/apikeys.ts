// Server-only helper to load + decrypt a user's LLM API keys via the
// cookie-scoped Supabase client. Lives in lib/ (not in a route file) so it can
// be imported without tripping Next.js's route-export type constraint.
// Keys are stored encrypted at profiles.preferences.api_keys.
//
// DEMO CHOKEPOINT: this is the request-context loader described at length in
// lib/harness/keys.ts — read that header for why the demo spend and expiry
// guards belong at the key sources rather than in every route, and for the
// full list of the three files that read key material out of a profile. All
// three select the same columns and run the same applyDemoKeyGuards, so a demo
// cannot get a differently-guarded key blob depending on which one a feature
// happens to call.
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, isEncrypted } from '@/lib/crypto'
import { resolveProviderPreferences } from '@/lib/harness/providers'
import { applyDemoKeyGuards, readProfileForDemoGuards, type KeyLoaderProfileRow } from '@/lib/harness/keys'
import { REASONING_EFFORTS, type DecryptedApiKeys, type ReasoningEffort } from '@/lib/harness/types'

/**
 * @deprecated use DecryptedApiKeys from '@/lib/harness/types' directly — this
 * alias exists only so any pre-existing `import type { ApiKeys }` keeps
 * resolving. The two shapes were duplicates of each other; this file no
 * longer maintains its own copy (its old `[key: string]: string | undefined`
 * index signature could never hold the new non-string `provider` field).
 */
export type ApiKeys = DecryptedApiKeys

/**
 * Get decrypted API keys for server-side use only.
 * Never expose the return value to the client.
 *
 * Throws DemoAccessError when the caller is a demo whose 72 hours are up (or
 * whose profile cannot be read at all). Callers that only want to know whether
 * a key EXISTS — app/api/settings/status — already treat a throw as "no key",
 * which is the right answer for an expired demo too.
 */
export async function getDecryptedApiKeys(userId: string): Promise<DecryptedApiKeys> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  // is_demo / demo_expires_at arrive with the access-codes migration and are
  // not in @cello/shared's generated Database type yet, so the select is made
  // through an untyped view of the same client — the same escape hatch
  // app/api/access-codes/route.ts uses for the identical reason.
  const db = supabase as unknown as SupabaseClient

  // Tolerates a schema that predates the access-codes migration: without this
  // a missing is_demo column failed the whole select, and because api_keys live
  // in the same row it disabled EVERY AI feature. See readProfileForDemoGuards.
  const { row: profile, error } = await readProfileForDemoGuards(db, userId)

  if (error) {
    // See lib/harness/keys.ts: an unreadable profile refuses below, so name the
    // cause here rather than leaving a silent failure. No key material.
    console.error(`apikeys: profile read failed for ${userId} — ${error.message}`)
  }

  const row = (profile ?? null) as KeyLoaderProfileRow | null
  const preferences = ((row?.preferences as Record<string, unknown> | null) || {}) as Record<string, unknown>
  const encryptedKeys = (preferences.api_keys || {}) as Record<string, string | undefined>

  const decryptedKeys: DecryptedApiKeys = {}

  try {
    for (const provider of ['openai', 'anthropic', 'openrouter'] as const) {
      const value = encryptedKeys[provider]
      if (value) {
        decryptedKeys[provider] = isEncrypted(value) ? decrypt(value) : value
      }
    }
  } catch (error) {
    console.error('Failed to decrypt API keys:', error)
  }

  // Per-user preferred model (plain string, NOT encrypted).
  const model = preferences.model
  if (typeof model === 'string' && model.trim()) decryptedKeys.model = model.trim()

  // Per-user LLM backend choice + default reasoning effort. Neither is
  // secret — never encrypted. resolveProviderPreferences fills in defaults
  // (active: 'openrouter') even when preferences.provider was never saved,
  // so callers can read apiKeys.provider.active without an extra `?? `.
  decryptedKeys.provider = resolveProviderPreferences(preferences.provider)
  const reasoningEffort = preferences.reasoningEffort
  if (typeof reasoningEffort === 'string' && (REASONING_EFFORTS as readonly string[]).includes(reasoningEffort)) {
    decryptedKeys.reasoningEffort = reasoningEffort as ReasoningEffort
  }

  // Last, so no return path can skip the guards: refuses an expired demo, and
  // re-attributes a live demo's spend to its own $1 ledger.
  return applyDemoKeyGuards({ ...decryptedKeys, userId }, row, userId)
}
