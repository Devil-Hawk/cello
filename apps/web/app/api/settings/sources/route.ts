// GET/POST/DELETE /api/settings/sources — the Apify BYOK token used by the
// 'apify' knowledge-base connector (lib/kb/connectors/apify.ts).
//
// Stored ENCRYPTED beside the existing 'hunter' slot at
// profiles.preferences.api_keys.apify — same shape, same encrypt()/decrypt()
// round trip as app/api/settings/keys/route.ts, just a different provider
// key. Kept as its own route (rather than folding into /api/settings/keys,
// which is owned by another workflow in this build) and scoped to the
// knowledge-base Sources tab.
//
// GET never returns the token itself — only whether one is configured, same
// discipline as every other key-presence check in this app.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/crypto'
import { DEFAULT_APIFY_ACTOR_ID } from '@/lib/apify/client'

/**
 * The RAW (still-encrypted) api_keys blob as stored in profiles.preferences.
 * Deliberately NOT lib/apikeys.ts's ApiKeys/DecryptedApiKeys — that type
 * describes DECRYPTED values read for LLM calls and has no index signature
 * (so it can't hold an arbitrary 'apify' string). This route only ever reads
 * and writes the encrypted blob, same as app/api/settings/keys/route.ts.
 */
type RawApiKeysBlob = Record<string, string | undefined>

export const dynamic = 'force-dynamic'

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

  return NextResponse.json({
    hasApifyToken: present(apiKeys.apify),
    defaultApifyActorId: DEFAULT_APIFY_ACTOR_ID,
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
  const token = (body as { apifyToken?: unknown } | null)?.apifyToken
  if (typeof token !== 'string' || !token.trim()) {
    return NextResponse.json({ error: 'apifyToken is required' }, { status: 400 })
  }
  if (token.includes('•')) {
    return NextResponse.json({ error: 'That looks like the masked placeholder, not a real token' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .maybeSingle()
  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  const apiKeys = (preferences.api_keys || {}) as RawApiKeysBlob

  const { error } = await supabase
    .from('profiles')
    .update({ preferences: { ...preferences, api_keys: { ...apiKeys, apify: encrypt(token.trim()) } } })
    .eq('id', user.id)

  if (error) {
    console.error('[settings/sources] save token failed:', error.message)
    return NextResponse.json({ error: 'Failed to save Apify token' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, hasApifyToken: true })
}

export async function DELETE() {
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
  delete apiKeys.apify

  const { error } = await supabase
    .from('profiles')
    .update({ preferences: { ...preferences, api_keys: apiKeys } })
    .eq('id', user.id)

  if (error) return NextResponse.json({ error: 'Failed to remove Apify token' }, { status: 500 })
  return NextResponse.json({ ok: true, hasApifyToken: false })
}
