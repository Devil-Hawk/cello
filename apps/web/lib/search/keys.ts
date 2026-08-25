// Read this user's own search-provider BYOK config from the SAME encrypted
// slot every other opt-in provider key lives in: profiles.preferences.api_keys.
// Deliberately does NOT go through lib/harness/keys.ts loadApiKeys /
// lib/apikeys.ts getDecryptedApiKeys — those two only decrypt the three LLM
// provider keys (openai/anthropic/openrouter); extending their provider loop
// belongs to whichever workstream owns those shared files, not this one.
// Mirrors the exact precedent already set by lib/contacts/keys.ts
// (hunter/apollo) and lib/kb/connectors/apify.ts (apify) for this exact slot.
//
// Absent key => undefined => lib/search/index.ts falls back to the next
// backend in its chain, never an error. Framework-free (no next/* imports)
// so this works from a request route AND a future harness/cron context.

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, isEncrypted } from '@/lib/crypto'

async function readApiKeys(client: SupabaseClient, userId: string): Promise<Record<string, unknown>> {
  const { data } = await client.from('profiles').select('preferences').eq('id', userId).single()
  const preferences = ((data as { preferences?: unknown } | null)?.preferences || {}) as Record<string, unknown>
  return (preferences.api_keys || {}) as Record<string, unknown>
}

function decryptMaybe(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    return isEncrypted(raw) ? decrypt(raw) : raw
  } catch {
    return undefined
  }
}

/** Accepts any Supabase client (cookie-scoped OR service-role admin) — only ever reads one JSON column. */
export async function getExaKey(client: SupabaseClient, userId: string): Promise<string | undefined> {
  const apiKeys = await readApiKeys(client, userId)
  return decryptMaybe(apiKeys.exa)
}

/** Every per-user search-backend credential this app knows how to store —
 *  ONE DB round trip instead of the 3 separate ones calling getExaKey +
 *  getTavilyKey + getSerperKey back-to-back would cost. Used by
 *  lib/search/index.ts's failover chain when it needs to resolve every
 *  not-already-provided credential for a userId in a single pass; the
 *  individual getters above stay as the simple, single-field path for
 *  existing callers (job-discovery.ts, copilot-tools.ts) that only ever
 *  wanted one. Deliberately does NOT include searxngBaseUrl — that one also
 *  needs the env var fallback (see getSearxngBaseUrl), so callers that want
 *  it call that getter directly. */
export async function getSearchProviderKeys(
  client: SupabaseClient,
  userId: string
): Promise<{ exa?: string; tavily?: string; serper?: string }> {
  const apiKeys = await readApiKeys(client, userId)
  return {
    exa: decryptMaybe(apiKeys.exa),
    tavily: decryptMaybe(apiKeys.tavily),
    serper: decryptMaybe(apiKeys.serper),
  }
}

/**
 * This user's own Tavily API key (BYOK) — profiles.preferences.api_keys.tavily.
 * Absent/corrupt => undefined, never a throw (see module header).
 */
export async function getTavilyKey(client: SupabaseClient, userId: string): Promise<string | undefined> {
  const apiKeys = await readApiKeys(client, userId)
  return decryptMaybe(apiKeys.tavily)
}

/**
 * This user's own Serper API key (BYOK) — profiles.preferences.api_keys.serper.
 * Absent/corrupt => undefined, never a throw (see module header).
 */
export async function getSerperKey(client: SupabaseClient, userId: string): Promise<string | undefined> {
  const apiKeys = await readApiKeys(client, userId)
  return decryptMaybe(apiKeys.serper)
}

/**
 * Resolve the SearXNG instance base URL this user's search should hit — NOT
 * a secret, so it is stored/read the same way as the other slots here
 * (profiles.preferences.api_keys.searxng) purely for consistency, but is
 * never actually required to be encrypted-at-rest (decryptMaybe still
 * handles a plain, unencrypted URL string transparently — isEncrypted() is
 * false for it, so it's returned as-is).
 *
 * Resolution order:
 *   1. This user's own per-user override (profiles.preferences.api_keys.searxng)
 *      — lets one SaaS user point at their own instance.
 *   2. The deployment-wide SEARXNG_BASE_URL env var — lets a self-hosted,
 *      single-tenant Cello configure this once for every user with no DB
 *      write at all (the "zero-cost-forever, self-hosters" path).
 *   3. undefined => lib/search/index.ts never selects this backend.
 *
 * Trailing whitespace/slashes are left to backends/searxng.ts's own
 * normalizeBaseUrl() — this function only resolves WHICH string to use.
 */
export async function getSearxngBaseUrl(client: SupabaseClient, userId: string): Promise<string | undefined> {
  const apiKeys = await readApiKeys(client, userId)
  const perUser = decryptMaybe(apiKeys.searxng)
  if (perUser) return perUser
  const fromEnv = process.env.SEARXNG_BASE_URL
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined
}
