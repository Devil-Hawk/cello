// GET  /api/apply-credentials — the sign-ins this user has stored, WITHOUT secrets.
// POST /api/apply-credentials — store or replace one.
//
// THE ONE RULE THIS SURFACE EXISTS TO KEEP: a password goes IN through POST and
// never comes back out. There is no GET that returns one, no `?reveal=true`, no
// masked-with-a-reveal-button variant. lib/apply/vault.ts has no function that
// would let this file do otherwise — listCredentials cannot return secret
// material, and resolveCredentialFor (the one that can) is never called from a
// route. That is the design, not an oversight: a credential the user can read
// back is a credential anyone with their session can read back.
//
// AUTHORISATION is the caller's OWN cookie-scoped session, never the service
// key. Every row is fenced by RLS on `auth.uid() = user_id` plus a demo
// exclusion (20260803000004_apply_credentials.sql), so a bug in this file
// cannot reach another account's vault — the database refuses. The vault
// re-checks the demo fence in code as well, because RLS says nothing to a
// service-role client and this route should not be the only thing that does.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { encryptionStatus, listCredentials, saveCredential } from '@/lib/apply/vault'
import { NO_STORE, vaultErrorResponse } from './http'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const db = supabase as unknown as SupabaseClient

  try {
    const credentials = await listCredentials(db, user.id)
    return NextResponse.json(
      {
        credentials,
        // Sent with the LIST so the card can warn BEFORE anyone types a
        // password, rather than after — telling someone their password could
        // not be stored safely is much better done in advance. The reason is
        // named because this is a self-hosted, single-user deployment whose
        // owner is the person who can fix it; a message that says "something is
        // wrong" and nothing else would be useless to exactly the one reader
        // this surface has.
        encryption: encryptionStatus(),
      },
      { headers: NO_STORE }
    )
  } catch (error) {
    return vaultErrorResponse(error, 'list')
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  // THE BODY HOLDS A PASSWORD. It is destructured into named locals and handed
  // straight to the vault; it is never logged, never echoed back in an error,
  // never spread into an object that something else might serialise, and the
  // parse failure below deliberately does not include what failed to parse.
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json(
      { error: 'Expected a JSON body.' },
      { status: 400, headers: NO_STORE }
    )
  }

  const db = supabase as unknown as SupabaseClient

  try {
    const credential = await saveCredential(db, user.id, {
      host: typeof body.host === 'string' ? body.host : '',
      label: typeof body.label === 'string' ? body.label : null,
      provider: typeof body.provider === 'string' ? body.provider : null,
      username: typeof body.username === 'string' ? body.username : '',
      secret: typeof body.secret === 'string' ? body.secret : '',
    })

    // The response is the SUMMARY — no secret, by the type's construction.
    return NextResponse.json({ credential }, { status: 201, headers: NO_STORE })
  } catch (error) {
    return vaultErrorResponse(error, 'save')
  }
}
