// GET/PUT for profiles.preferences.gmail_permissions — the four independently
// grantable Gmail permission tiers (see lib/gmail/permissions.ts).
//
// GET also performs the one-time legacy migration: a user who already had
// Gmail sync running before this split shipped gets "monitor" carried
// forward as enabled, persisted explicitly (with migratedFrom set) so it
// shows up in the UI as a reversible, visible decision rather than a
// silent inference re-derived from gmail_sync on every read.
//
// PUT is read-modify-write, same reasoning as app/api/settings/targeting:
// preferences also holds api_keys, digest, targeting, model, gmail_sync —
// a naive `.update({ preferences: { gmail_permissions } })` would wipe them.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  applyGmailPermissionChange,
  parseGmailPermissions,
  withGmailPermissionState,
  type GmailPermissionTier,
} from '@/lib/gmail/permissions'
import type { Json } from '@cello/shared'

export const dynamic = 'force-dynamic'

const VALID_TIERS: GmailPermissionTier[] = ['send', 'readShared', 'monitor']

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[gmail/permissions] read failed:', error.message)
    return NextResponse.json({ error: 'Failed to load Gmail permissions' }, { status: 500 })
  }

  const parsed = parseGmailPermissions(profile?.preferences ?? null)

  if (parsed.needsMigrationPersist) {
    const nextPreferences = withGmailPermissionState(profile?.preferences ?? {}, parsed.state)
    const { error: writeError } = await supabase
      .from('profiles')
      // preferences is a plain, JSON-safe object built from the existing Json
      // column value plus plain-literal grant records — Json itself, just not
      // structurally provable through `Record<string, unknown>`.
      .update({ preferences: nextPreferences as unknown as Json })
      .eq('id', user.id)
    if (writeError) {
      // Non-fatal: the caller still gets the correct (in-memory) state this
      // request. It just won't be recorded as explicit until a later read
      // succeeds in persisting it.
      console.error('[gmail/permissions] migration persist failed:', writeError.message)
    }
  }

  return NextResponse.json({
    permissions: parsed.state,
    legacy: parsed.legacy,
    migrated: parsed.needsMigrationPersist,
  })
}

export async function PUT(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const tier = b.tier
  const enabled = b.enabled

  if (typeof tier !== 'string' || !VALID_TIERS.includes(tier as GmailPermissionTier)) {
    return NextResponse.json({ error: `tier must be one of: ${VALID_TIERS.join(', ')}` }, { status: 400 })
  }
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
  }

  const { data: profile, error: readError } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .maybeSingle()

  if (readError) {
    console.error('[gmail/permissions] pre-write read failed:', readError.message)
    return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 })
  }

  const nextPreferences = applyGmailPermissionChange(profile?.preferences ?? null, tier as GmailPermissionTier, enabled)

  const { error: writeError } = await supabase
    .from('profiles')
    .update({ preferences: nextPreferences as unknown as Json })
    .eq('id', user.id)

  if (writeError) {
    console.error('[gmail/permissions] write failed:', writeError.message)
    return NextResponse.json({ error: 'Failed to save Gmail permissions' }, { status: 500 })
  }

  return NextResponse.json({ permissions: nextPreferences.gmail_permissions })
}
