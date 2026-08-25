// Load + decrypt a user's LLM API keys through the service-role client.
//
// This mirrors getDecryptedApiKeys() from app/api/settings/keys/route.ts but
// reads via the admin client instead of the cookie-scoped server client, so it
// works in BOTH request and cron contexts (the cron route has no user session).
// Keys live encrypted at profiles.preferences.api_keys (NOT profiles.api_keys,
// which does not exist in prod). Never log or return raw key values elsewhere.

import { decrypt, isEncrypted } from '@/lib/crypto'
import { resolveProviderPreferences } from './providers'
import { REASONING_EFFORTS, type AdminClient, type DecryptedApiKeys, type ReasoningEffort } from './types'

export async function loadApiKeys(admin: AdminClient, userId: string): Promise<DecryptedApiKeys> {
  const { data: profile } = await admin
    .from('profiles')
    .select('preferences')
    .eq('id', userId)
    .single()

  const preferences = ((profile?.preferences as Record<string, unknown> | null) || {}) as Record<string, unknown>
  const encrypted = (preferences.api_keys || {}) as Record<string, string | undefined>

  const out: DecryptedApiKeys = {}
  for (const provider of ['openai', 'anthropic', 'openrouter'] as const) {
    const value = encrypted[provider]
    if (!value) continue
    try {
      out[provider] = isEncrypted(value) ? decrypt(value) : value
    } catch (err) {
      console.error(`harness: failed to decrypt ${provider} key for ${userId}`, err)
    }
  }

  // Per-user preferred model (plain string, NOT encrypted).
  const model = preferences.model
  if (typeof model === 'string' && model.trim()) out.model = model.trim()

  // Per-user LLM backend choice + default reasoning effort — neither is
  // secret, neither is encrypted. Mirrors lib/apikeys.ts's
  // getDecryptedApiKeys (the request-context sibling of this admin-context
  // loader); see that file's comment for why resolveProviderPreferences is
  // called unconditionally.
  out.provider = resolveProviderPreferences(preferences.provider)
  const reasoningEffort = preferences.reasoningEffort
  if (typeof reasoningEffort === 'string' && (REASONING_EFFORTS as readonly string[]).includes(reasoningEffort)) {
    out.reasoningEffort = reasoningEffort as ReasoningEffort
  }

  // Whose spend this is — required for the monthly cap (lib/harness/spend.ts).
  out.userId = userId

  return out
}
