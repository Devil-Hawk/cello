// GET  /api/settings/tokens        — the caller's own tokens (never a hash).
// POST /api/settings/tokens        — issue a new token. Returns the plaintext ONCE.
// DELETE /api/settings/tokens?id=  — revoke one.
//
// The machine-surface credential (binding ruling 5): MCP and A2A auth against
// these (lib/access/tokens.ts validateToken), not a cookie session. See
// supabase/migrations/20260819000001_api_tokens.sql for why creation,
// revocation and last-used tracking all go through the SERVICE-ROLE admin
// client rather than the caller's own RLS-scoped one — none of hashing,
// show-once, or the demo refusal below can be enforced by a bare PostgREST
// write. GET is the one verb that reads through the caller's own client: the
// owner-scoped SELECT policy already limits it to their own rows, and an
// untyped view is used because api_tokens postdates @cello/shared's generated
// Database type — the same escape hatch app/api/access-codes/route.ts uses.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createToken, revokeToken, type ApiTokenRecord } from '@/lib/access/tokens'
import { isDemoProfile, type DemoProfileFacts } from '@/lib/access/guardrails'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

const MAX_NAME_CHARS = 80
const MAX_SCOPES = 8
const MAX_EXPIRES_DAYS = 365
/** One scope, lowercase, matching the vocabulary lib/access/tokens.ts callers
 *  use ('mcp', 'a2a', …) without pinning that list here — the surfaces that
 *  actually check a scope are the ones that get to define it. */
const SCOPE_RE = /^[a-z][a-z0-9_:-]{0,39}$/

const DEMO_CANNOT_ISSUE = 'Demo workspaces cannot issue access tokens.'

/** The client-safe view of a row — never token_hash. */
function toPublicToken(row: ApiTokenRecord) {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  }
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const db = supabase as unknown as SupabaseClient
  const { data, error } = await db
    .from('api_tokens')
    .select('id, name, scopes, expires_at, revoked_at, last_used_at, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[settings/tokens] list failed', error)
    return NextResponse.json({ error: "Couldn't load your access tokens." }, { status: 500, headers: NO_STORE })
  }

  const tokens = (data ?? []).map((row) =>
    toPublicToken({
      id: row.id,
      name: row.name,
      scopes: row.scopes ?? [],
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
    })
  )

  return NextResponse.json({ tokens }, { headers: NO_STORE })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  // A DEMO SESSION MAY NOT ISSUE TOKENS. Same reasoning as
  // app/api/access-codes/route.ts's POST: fails closed on an unreadable
  // profile, because an unprovable "not a demo" must not become an issued
  // credential. The database's forbid_demo_api_tokens trigger is the
  // backstop for anything that reaches the write without passing this check.
  const db = supabase as unknown as SupabaseClient
  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('is_demo, demo_expires_at')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError || !profile) {
    console.error('[settings/tokens] could not verify the caller is not a demo', profileError)
    return NextResponse.json(
      { error: "We couldn't verify your account, so no token was issued." },
      { status: 403, headers: NO_STORE }
    )
  }
  if (isDemoProfile(profile as DemoProfileFacts)) {
    return NextResponse.json({ error: DEMO_CANNOT_ISSUE }, { status: 403, headers: NO_STORE })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE })
  }
  const raw = (body ?? {}) as Record<string, unknown>

  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name || name.length > MAX_NAME_CHARS) {
    return NextResponse.json(
      { error: `Give the token a name, up to ${MAX_NAME_CHARS} characters.` },
      { status: 400, headers: NO_STORE }
    )
  }

  const rawScopes = Array.isArray(raw.scopes) ? raw.scopes : []
  const scopes = [...new Set(rawScopes.filter((s): s is string => typeof s === 'string'))]
  if (scopes.length === 0 || scopes.length > MAX_SCOPES || !scopes.every((s) => SCOPE_RE.test(s))) {
    return NextResponse.json(
      { error: `Pick at least one scope, up to ${MAX_SCOPES}, lowercase letters/numbers/-/_/: only.` },
      { status: 400, headers: NO_STORE }
    )
  }

  let expiresAt: Date | null = null
  if (raw.expiresInDays !== undefined && raw.expiresInDays !== null) {
    const days = Number(raw.expiresInDays)
    if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRES_DAYS) {
      return NextResponse.json(
        { error: `expiresInDays must be between 1 and ${MAX_EXPIRES_DAYS}.` },
        { status: 400, headers: NO_STORE }
      )
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  }

  try {
    const admin = createAdminClient()
    const issued = await createToken(admin, { userId: user.id, name, scopes, expiresAt })
    return NextResponse.json(
      {
        // THE ONLY TIME THIS VALUE EXISTS OUTSIDE THE HOLDER'S HANDS.
        token: issued.token,
        summary: toPublicToken(issued),
      },
      { status: 201, headers: NO_STORE }
    )
  } catch (err) {
    console.error('[settings/tokens] create failed', err)
    return NextResponse.json(
      { error: "Couldn't issue a token right now. Try again." },
      { status: 500, headers: NO_STORE }
    )
  }
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const id = request.nextUrl.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400, headers: NO_STORE })
  }

  try {
    const admin = createAdminClient()
    const revoked = await revokeToken(admin, user.id, id)
    if (!revoked) {
      return NextResponse.json({ error: 'Token not found' }, { status: 404, headers: NO_STORE })
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (err) {
    console.error('[settings/tokens] revoke failed', err)
    return NextResponse.json({ error: "Couldn't revoke that token. Try again." }, { status: 500, headers: NO_STORE })
  }
}
