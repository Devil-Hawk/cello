import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDecryptedApiKeys } from '@/lib/apikeys'
import { isAllowedModel } from '@/lib/models'
import { isTargetingConfigured, resolveTargeting } from '@/lib/targeting'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'

// Single source of truth for "is this account set up yet?".
//
// Replaces the broken inline checks in app/(app)/dashboard/page.tsx and
// app/(app)/jobs/page.tsx, which did `.select('resume_text, api_keys')` on
// profiles. There IS no `profiles.api_keys` column — PostgREST rejected the
// whole SELECT with 42703, so `hasResume` and `hasApiKey` were BOTH always
// false and the "add an API key" nag never cleared even with a key saved.
// Keys really live at profiles.preferences.api_keys (encrypted).
//
// SECURITY: this endpoint returns booleans and the model id ONLY. No key
// material, no key prefixes, no lengths — nothing that narrows a secret.

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // resume_text is a real column; preferences is the real jsonb home for keys,
  // the model choice and targeting. Selecting only columns that exist is the
  // whole point of this route.
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('resume_text, preferences')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[settings/status] profile read failed:', error.message)
    return NextResponse.json({ error: 'Failed to load profile status' }, { status: 500 })
  }

  const preferences = (profile?.preferences || {}) as Record<string, unknown>

  // Decrypted only to test presence; the values never leave this function.
  let keys: Awaited<ReturnType<typeof getDecryptedApiKeys>> = {}
  try {
    keys = await getDecryptedApiKeys(user.id)
  } catch (e) {
    // A corrupt ciphertext must not 500 the whole settings page — report the
    // key as absent so the UI prompts the user to re-enter it.
    console.error('[settings/status] key decrypt failed:', e)
  }

  // Hunter is a plain opt-in enrichment key that getDecryptedApiKeys does not
  // decrypt (it is not an LLM provider), so presence is read straight off the
  // stored blob. Still only ever surfaced as a boolean.
  const storedKeys = (preferences.api_keys || {}) as Record<string, unknown>
  const present = (v: unknown) => typeof v === 'string' && v.trim().length > 0

  const keyFlags = {
    openrouter: present(keys.openrouter),
    openai: present(keys.openai),
    anthropic: present(keys.anthropic),
    hunter: present(storedKeys.hunter),
  }

  const rawModel = preferences.model
  const model = isAllowedModel(rawModel) ? rawModel : null

  // PROVIDER GATE ALIGNMENT: the harness runtime (lib/harness/llm.ts) calls
  // OpenRouter ONLY, so "can this account run an LLM feature" is exactly
  // "does it have an OpenRouter key" — NOT "does it have any provider key".
  // hasKey previously meant the latter (openrouter||openai||anthropic), which
  // handed out match/optimizer UI affordances to openai/anthropic-only
  // accounts that then 400'd on click. hasKey now means canRunLlm; keyProvider
  // + llmKeyMessage let the client explain the gap instead of just hiding
  // things silently.
  const llmReady = canRunLlm(keys)

  return NextResponse.json({
    hasResume: present(profile?.resume_text),
    // "Can this account run an LLM feature right now" — OpenRouter only.
    hasKey: llmReady,
    canRunLlm: llmReady,
    // Which provider key actually grants LLM capability (openrouter, or null
    // if absent). A truthy openai/anthropic key is visible in `keys` below but
    // deliberately does NOT make this non-null — it does not enable anything.
    keyProvider: llmReady ? ('openrouter' as const) : null,
    // Actionable copy for the "add a key" banner when llmReady is false, e.g.
    // distinguishing "no key at all" from "wrong provider's key saved".
    llmKeyMessage: llmReady ? null : missingOpenRouterMessage(keys),
    keys: keyFlags,
    model,
    targetingConfigured: isTargetingConfigured(resolveTargeting(preferences)),
  })
}
