// Server-only helper to load + decrypt a user's LLM API keys via the
// cookie-scoped Supabase client. Lives in lib/ (not in a route file) so it can
// be imported without tripping Next.js's route-export type constraint.
// Keys are stored encrypted at profiles.preferences.api_keys.
import { decrypt, isEncrypted } from '@/lib/crypto'
import { resolveProviderPreferences } from '@/lib/harness/providers'
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
 */
export async function getDecryptedApiKeys(userId: string): Promise<DecryptedApiKeys> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', userId)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, unknown>
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

  return { ...decryptedKeys, userId }
}
