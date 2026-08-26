import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  APPLICATION_IDENTITY_KEY,
  readApplicationIdentitySettings,
  resolveApplicationIdentity,
  serializeApplicationIdentity,
  validateApplicationIdentityUpdate,
} from '@/lib/apply/identity'

// GET/PUT for profiles.preferences.applicationIdentity — the name, address and
// links that go ON a job application, which the user may deliberately keep
// different from the ones their account was created with.
//
// PUT is read-modify-write: preferences also holds api_keys, targeting, budget,
// digest and gmail_sync. A naive `.update({ preferences: { applicationIdentity } })`
// would silently wipe the user's saved API keys and every other preference.
// Always read the current row first and spread it before writing. (Same rule,
// same reason, as app/api/settings/targeting/route.ts.)
//
// THE ACCOUNT ADDRESS IS NOT EDITABLE HERE. It comes from Supabase auth, which
// is the only address that has actually been proven to reach this human — it is
// what auth, billing and Cello's own notifications keep using. This route only
// ever changes which address employers see. See lib/apply/identity.ts's
// emailForAudience() for the boundary in executable form.

/** The auth address is authoritative; the profiles mirror is the fallback if it's ever empty. */
function accountEmailOf(authEmail: string | undefined, profileEmail: unknown): string {
  if (typeof authEmail === 'string' && authEmail.trim()) return authEmail.trim()
  return typeof profileEmail === 'string' ? profileEmail.trim() : ''
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('full_name, email, preferences')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[settings/application-identity] read failed:', error.message)
    return NextResponse.json({ error: 'Failed to load application identity' }, { status: 500 })
  }

  const identity = resolveApplicationIdentity({
    full_name: profile?.full_name as string | null,
    email: accountEmailOf(user.email, profile?.email),
    preferences: profile?.preferences,
  })

  return NextResponse.json({ identity })
}

export async function PUT(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { data: profile, error: readError } = await supabase
    .from('profiles')
    .select('full_name, email, preferences')
    .eq('id', user.id)
    .maybeSingle()

  if (readError) {
    console.error('[settings/application-identity] pre-write read failed:', readError.message)
    return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 })
  }

  const accountEmail = accountEmailOf(user.email, profile?.email)
  const validation = validateApplicationIdentityUpdate(body, {
    accountEmail,
    // Passed so an address the user already confirmed doesn't demand a fresh
    // confirmation every time they edit their phone number.
    existing: readApplicationIdentitySettings(profile?.preferences),
  })

  if (!validation.ok) {
    // needsConfirmation is a prompt, not a scolding: the card turns it into the
    // "yes, employers should reply to this address" checkbox and re-submits.
    return NextResponse.json(
      { error: validation.error, needsConfirmation: validation.needsConfirmation },
      { status: 400 }
    )
  }

  const preferences = (profile?.preferences && typeof profile.preferences === 'object'
    ? profile.preferences
    : {}) as Record<string, unknown>

  const { error: writeError } = await supabase
    .from('profiles')
    .update({
      preferences: {
        ...preferences,
        [APPLICATION_IDENTITY_KEY]: serializeApplicationIdentity(validation.settings),
      },
    })
    .eq('id', user.id)

  if (writeError) {
    console.error('[settings/application-identity] write failed:', writeError.message)
    return NextResponse.json({ error: 'Failed to save application identity' }, { status: 500 })
  }

  // Resolve from what was actually stored, not from the request: the client
  // then renders the same identity every other consumer will see, including
  // any fallback it just triggered by clearing a field.
  const identity = resolveApplicationIdentity({
    full_name: profile?.full_name as string | null,
    email: accountEmail,
    preferences: {
      ...preferences,
      [APPLICATION_IDENTITY_KEY]: serializeApplicationIdentity(validation.settings),
    },
  })

  return NextResponse.json({ identity })
}
