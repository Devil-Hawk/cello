// GET/POST/DELETE /api/settings/search — BYOK config for lib/search/index.ts's
// failover chain: Tavily / Serper / Exa keys and a SearXNG base URL, all
// stored ENCRYPTED beside the other opt-in provider keys at
// profiles.preferences.api_keys.{tavily,serper,exa,searxng} — same shape,
// same encrypt()/decrypt() round trip as app/api/settings/keys/route.ts.
// Kept as its own route (rather than folding into /api/settings/keys, which
// is owned by another workflow in this build) — same precedent
// app/api/settings/sources/route.ts already set for the Apify token.
//
// GET also reports, HONESTLY and live (never hardcoded), which backends this
// build's code can actually run right now (lib/search/index.ts's own
// loadOptionalBackendFn probe — the same mechanism the chain itself uses to
// decide whether tavily/serper/searxng are available) and each backend's
// current health-memory status (lib/search/health.ts), so the Search
// settings tab never overclaims what will happen on the next real search.
//
// GET never returns a key itself — only whether one is configured, same
// discipline as every other key-presence check in this app.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/crypto'
import { loadOptionalBackendFn, type OptionalBackendId } from '@/lib/search'
import { getAllBackendHealth } from '@/lib/search/health'
import type { SearchBackendId } from '@/lib/search/types'

export const dynamic = 'force-dynamic'

/** The RAW (still-encrypted) api_keys blob as stored in profiles.preferences —
 *  same discipline as app/api/settings/sources/route.ts's RawApiKeysBlob. */
type RawApiKeysBlob = Record<string, string | undefined>

type ManagedProvider = 'tavily' | 'serper' | 'exa' | 'searxng'
const MANAGED_PROVIDERS: ManagedProvider[] = ['tavily', 'serper', 'exa', 'searxng']

/** The backends whose code ships as a separate lazily-loaded chunk, so its
 *  presence in THIS build is worth probing. lib/search/index.ts owns the
 *  module map itself — this list is just which ids to ask about. */
const OPTIONAL_MODULE_IDS: OptionalBackendId[] = ['tavily', 'serper', 'searxng']

const BACKEND_ORDER: SearchBackendId[] = ['tavily', 'serper', 'exa', 'searxng', 'duckduckgo']
const BACKEND_LABEL: Record<SearchBackendId, string> = {
  tavily: 'Tavily',
  serper: 'Serper',
  exa: 'Exa',
  searxng: 'SearXNG',
  duckduckgo: 'DuckDuckGo',
}

function present(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .maybeSingle()
  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  const apiKeys = (preferences.api_keys || {}) as RawApiKeysBlob

  const configured: Record<SearchBackendId, boolean> = {
    tavily: present(apiKeys.tavily),
    serper: present(apiKeys.serper),
    exa: present(apiKeys.exa),
    searxng: present(apiKeys.searxng),
    duckduckgo: true, // keyless, always usable
  }

  // Live probe — imports each optional module the exact same way the search
  // chain itself does, so "available" here can never drift from reality.
  const moduleAvailable: Partial<Record<SearchBackendId, boolean>> = {}
  await Promise.all(
    OPTIONAL_MODULE_IDS.map(async (id) => {
      moduleAvailable[id] = (await loadOptionalBackendFn(id)) !== null
    })
  )

  const health = getAllBackendHealth()
  const healthByBackend = new Map(health.map((h) => [h.backend, h]))

  const backends = BACKEND_ORDER.map((id) => {
    const rec = healthByBackend.get(id)
    return {
      id,
      label: BACKEND_LABEL[id],
      configured: configured[id],
      // exa/duckduckgo ship in this build unconditionally; the other three
      // depend on backends/*.ts having landed — see the module header.
      codeAvailable: id === 'exa' || id === 'duckduckgo' ? true : Boolean(moduleAvailable[id]),
      health: rec ? { reason: rec.reason, detail: rec.detail ?? null, retryAfterMs: Math.max(0, rec.retryAfter - Date.now()) } : null,
    }
  })

  return NextResponse.json({
    hasTavily: configured.tavily,
    hasSerper: configured.serper,
    hasExa: configured.exa,
    hasSearxng: configured.searxng,
    searxngEnvConfigured: present(process.env.SEARXNG_BASE_URL),
    backends,
  })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { tavily, serper, exa, searxngUrl } = (body ?? {}) as {
    tavily?: unknown
    serper?: unknown
    exa?: unknown
    searxngUrl?: unknown
  }

  const updates: Partial<Record<ManagedProvider, string>> = {}

  for (const [field, value] of [
    ['tavily', tavily],
    ['serper', serper],
    ['exa', exa],
  ] as const) {
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim()) {
      return NextResponse.json({ error: `${field} must be a non-empty string` }, { status: 400 })
    }
    if (value.includes('•')) {
      return NextResponse.json({ error: 'That looks like the masked placeholder, not a real key' }, { status: 400 })
    }
    updates[field] = value.trim()
  }

  if (searxngUrl !== undefined) {
    if (typeof searxngUrl !== 'string' || !searxngUrl.trim()) {
      return NextResponse.json({ error: 'searxngUrl must be a non-empty string' }, { status: 400 })
    }
    let parsed: URL
    try {
      parsed = new URL(searxngUrl.trim())
    } catch {
      return NextResponse.json({ error: 'searxngUrl must be a valid URL (e.g. https://searx.example.com)' }, { status: 400 })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return NextResponse.json({ error: 'searxngUrl must use http:// or https://' }, { status: 400 })
    }
    updates.searxng = searxngUrl.trim()
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No key provided' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .maybeSingle()
  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  const apiKeys = (preferences.api_keys || {}) as RawApiKeysBlob

  const newKeys: RawApiKeysBlob = { ...apiKeys }
  for (const [field, value] of Object.entries(updates)) {
    newKeys[field] = encrypt(value)
  }

  const { error } = await supabase
    .from('profiles')
    .update({ preferences: { ...preferences, api_keys: newKeys } })
    .eq('id', user.id)

  if (error) {
    console.error('[settings/search] save failed:', error.message)
    return NextResponse.json({ error: 'Failed to save search settings' }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    hasTavily: present(newKeys.tavily),
    hasSerper: present(newKeys.serper),
    hasExa: present(newKeys.exa),
    hasSearxng: present(newKeys.searxng),
  })
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const provider = searchParams.get('provider') as ManagedProvider | null
  if (!provider || !MANAGED_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: 'Invalid provider' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .maybeSingle()
  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  const apiKeys = (preferences.api_keys || {}) as RawApiKeysBlob
  delete apiKeys[provider]

  const { error } = await supabase
    .from('profiles')
    .update({ preferences: { ...preferences, api_keys: apiKeys } })
    .eq('id', user.id)

  if (error) return NextResponse.json({ error: 'Failed to remove key' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
