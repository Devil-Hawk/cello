// GET/POST /api/settings/providers — report which LLM backends are ACTUALLY
// available on this machine right now, and persist the user's choice.
//
// This is the one place that runs live detection (CLI binaries on PATH, a
// local server's /models endpoint) rather than just trusting configuration —
// see lib/harness/providers/{local-cli,local-server}.ts for the detection
// functions themselves. Never returns secret values: OpenRouter's own key is
// reported as a boolean (`configured`), same as /api/settings/keys already
// does; the other two backends need no key at all.

import { NextRequest, NextResponse } from 'next/server'
import type { Json } from '@cello/shared'
import { createClient } from '@/lib/supabase/server'
import { REASONING_EFFORTS, type ReasoningEffort } from '@/lib/harness/types'
import {
  LOCAL_CLI_IDS,
  PROVIDER_CAPABILITIES,
  PROVIDER_DESCRIPTIONS,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  isSelfHosted,
  resolveLocalCliId,
  resolveProviderId,
  resolveProviderPreferences,
} from '@/lib/harness/providers'
import { detectAllLocalClis } from '@/lib/harness/providers/local-cli'
import { detectLocalServer } from '@/lib/harness/providers/local-server'

export const dynamic = 'force-dynamic'

// This module must export ONLY GET/POST — see lib/models.ts's comment on the
// same Next.js route-export constraint (`tsc --noEmit` does not catch a
// violation; only `next build` does).

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  const storedKeys = (preferences.api_keys || {}) as Record<string, unknown>
  const hasOpenrouterKey = typeof storedKeys.openrouter === 'string' && storedKeys.openrouter.trim().length > 0

  const providerPrefs = resolveProviderPreferences(preferences.provider)
  const selfHosted = isSelfHosted()

  const [clis, localServer] = await Promise.all([
    detectAllLocalClis(),
    detectLocalServer(providerPrefs.localServerBaseUrl),
  ])
  const anyCliAvailable = clis.some((c) => c.available)

  const rawReasoning = preferences.reasoningEffort
  const reasoningEffort: ReasoningEffort = (
    typeof rawReasoning === 'string' && (REASONING_EFFORTS as readonly string[]).includes(rawReasoning)
      ? rawReasoning
      : 'none'
  ) as ReasoningEffort

  return NextResponse.json({
    selfHosted,
    active: providerPrefs.active,
    preferences: providerPrefs,
    reasoningEffort,
    reasoningEfforts: REASONING_EFFORTS,
    providers: {
      openrouter: {
        label: PROVIDER_LABELS.openrouter,
        description: PROVIDER_DESCRIPTIONS.openrouter,
        capabilities: PROVIDER_CAPABILITIES.openrouter,
        // Works everywhere Cello runs — "available" here means "usable
        // right now", which for a keyed API is exactly "is a key saved".
        available: hasOpenrouterKey,
        configured: hasOpenrouterKey,
        reason: hasOpenrouterKey ? undefined : 'No OpenRouter key saved — add one in Settings → API keys.',
      },
      'local-cli': {
        label: PROVIDER_LABELS['local-cli'],
        description: PROVIDER_DESCRIPTIONS['local-cli'],
        capabilities: PROVIDER_CAPABILITIES['local-cli'],
        available: selfHosted && anyCliAvailable,
        reason: !selfHosted
          ? 'Requires self-hosting — this Cello instance is running on Vercel serverless.'
          : anyCliAvailable
            ? undefined
            : 'None of claude, codex, or gemini were found on PATH.',
        clis,
      },
      'local-server': {
        label: PROVIDER_LABELS['local-server'],
        description: PROVIDER_DESCRIPTIONS['local-server'],
        capabilities: PROVIDER_CAPABILITIES['local-server'],
        available: localServer.available,
        reason: localServer.reason,
        models: localServer.models,
      },
    },
  })
}

interface ProvidersPostBody {
  provider?: string
  localCli?: string
  localServerBaseUrl?: string
  localServerModel?: string
  reasoningEffort?: string
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as ProvidersPostBody

  if (body.provider !== undefined && !(PROVIDER_IDS as readonly string[]).includes(body.provider)) {
    return NextResponse.json({ error: 'Invalid provider id' }, { status: 400 })
  }
  if (body.localCli !== undefined && !(LOCAL_CLI_IDS as readonly string[]).includes(body.localCli)) {
    return NextResponse.json({ error: 'Invalid local CLI id' }, { status: 400 })
  }
  if (
    body.reasoningEffort !== undefined &&
    !(REASONING_EFFORTS as readonly string[]).includes(body.reasoningEffort)
  ) {
    return NextResponse.json({ error: 'Invalid reasoning effort' }, { status: 400 })
  }
  if (body.localServerBaseUrl) {
    try {
      const parsed = new URL(body.localServerBaseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
    } catch {
      return NextResponse.json({ error: 'Local server URL must be a valid http(s) URL' }, { status: 400 })
    }
  }

  // Read-modify-write so api_keys/model/targeting (and any other prefs)
  // survive — same pattern as /api/settings/model.
  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, Json | undefined>
  const existing = resolveProviderPreferences(preferences.provider)

  const nextProvider = {
    active: body.provider !== undefined ? resolveProviderId(body.provider) : existing.active,
    localCli: body.localCli !== undefined ? resolveLocalCliId(body.localCli) : existing.localCli,
    localServerBaseUrl:
      body.localServerBaseUrl !== undefined ? body.localServerBaseUrl.trim() : existing.localServerBaseUrl,
    localServerModel:
      body.localServerModel !== undefined ? body.localServerModel.trim() : existing.localServerModel,
  }

  const nextPreferences: Record<string, Json | undefined> = { ...preferences, provider: nextProvider }
  if (body.reasoningEffort !== undefined) {
    nextPreferences.reasoningEffort = body.reasoningEffort
  }

  const { error } = await supabase.from('profiles').update({ preferences: nextPreferences }).eq('id', user.id)

  if (error) {
    console.error('Failed to save provider preferences:', error)
    return NextResponse.json({ error: 'Failed to save provider preferences' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    preferences: nextProvider,
    reasoningEffort: (nextPreferences.reasoningEffort as string | undefined) ?? 'none',
  })
}
