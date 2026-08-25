import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveTargeting, serializeTargeting, type Targeting } from '@/lib/targeting'

// GET/PUT for profiles.preferences.targeting.
//
// PUT is read-modify-write: preferences also holds api_keys, digest, model and
// gmail_sync. A naive `.update({ preferences: { targeting } })` would silently
// wipe the user's saved API keys and every other preference. Always read the
// current row first and spread it before writing.

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

/** Strict shape validation for the PUT body. Returns an error message, or null when valid. */
function validate(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'Request body must be an object'
  const b = body as Record<string, unknown>

  for (const field of ['functions', 'seniority', 'countries', 'languages', 'excludedCompanies', 'excludedKeywords'] as const) {
    if (field in b && b[field] !== undefined && !isStringArray(b[field])) {
      return `${field} must be an array of strings`
    }
  }

  if ('remoteOnly' in b && b.remoteOnly !== undefined && typeof b.remoteOnly !== 'boolean') {
    return 'remoteOnly must be a boolean'
  }

  if ('minScore' in b && b.minScore !== undefined && b.minScore !== null) {
    if (typeof b.minScore !== 'number' || !Number.isFinite(b.minScore) || b.minScore < 0 || b.minScore > 100) {
      return 'minScore must be a number between 0 and 100, or null'
    }
  }

  return null
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[settings/targeting] read failed:', error.message)
    return NextResponse.json({ error: 'Failed to load targeting' }, { status: 500 })
  }

  const targeting = resolveTargeting(profile?.preferences ?? null)
  return NextResponse.json({ targeting })
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

  const validationError = validate(body)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }

  // Normalize casing/dedupe/clamping the same way every other reader does, by
  // routing the validated body back through resolveTargeting.
  const targeting: Targeting = resolveTargeting({ targeting: body })

  const { data: profile, error: readError } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .maybeSingle()

  if (readError) {
    console.error('[settings/targeting] pre-write read failed:', readError.message)
    return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 })
  }

  const preferences = (profile?.preferences && typeof profile.preferences === 'object'
    ? profile.preferences
    : {}) as Record<string, unknown>

  // Targeting is a plain interface (no string index signature), so the
  // generated Json column type won't structurally accept it directly. Round
  // it through JSON to get a plain, Json-compatible value — every Targeting
  // field is already a string/number/boolean/null/array, so this is lossless.
  const targetingRecord = JSON.parse(JSON.stringify(serializeTargeting(targeting)))

  const { error: writeError } = await supabase
    .from('profiles')
    .update({ preferences: { ...preferences, targeting: targetingRecord } })
    .eq('id', user.id)

  if (writeError) {
    console.error('[settings/targeting] write failed:', writeError.message)
    return NextResponse.json({ error: 'Failed to save targeting' }, { status: 500 })
  }

  return NextResponse.json({ targeting })
}
