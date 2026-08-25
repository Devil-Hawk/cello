// GET  /api/digest — compose + return today's digest for in-app rendering.
// POST /api/digest — persist the opt-in flag (+ optional sendHour) under
//                    profiles.preferences.digest. Default OFF.
//
// No LLM, no external fetch — the digest is composed entirely from stored data.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { composeDigest } from '@/lib/digest/compose'
import { resolveDigestPreferences } from '@/lib/digest/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: profile } = await admin
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()
  const preferences = ((profile?.preferences as Record<string, unknown> | null) || {}) as Record<
    string,
    unknown
  >
  const prefs = resolveDigestPreferences(preferences.digest)

  try {
    const digest = await composeDigest(admin, user.id)
    return NextResponse.json({ ok: true, digest, preferences: prefs })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to compose digest' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { enabled?: unknown; sendHour?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled (boolean) is required' }, { status: 400 })
  }

  // Read-modify-write the shared preferences jsonb; touch ONLY the .digest subkey.
  // Uses the untyped admin client (scoped by user id) so the nested jsonb is not
  // constrained by the generated Json type.
  const admin = createAdminClient()
  const { data: profile } = await admin
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()
  const preferences = ((profile?.preferences as Record<string, unknown> | null) || {}) as Record<
    string,
    unknown
  >
  const existingDigest = (preferences.digest as Record<string, unknown> | undefined) || {}

  const nextDigest: Record<string, unknown> = { ...existingDigest, enabled: body.enabled }
  if (typeof body.sendHour === 'number' && Number.isFinite(body.sendHour)) {
    nextDigest.sendHour = Math.min(23, Math.max(0, Math.floor(body.sendHour)))
  }

  const { error } = await admin
    .from('profiles')
    .update({ preferences: { ...preferences, digest: nextDigest } })
    .eq('id', user.id)
  if (error) {
    return NextResponse.json({ error: 'Failed to save preference' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, preferences: resolveDigestPreferences(nextDigest) })
}
