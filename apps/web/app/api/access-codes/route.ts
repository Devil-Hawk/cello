// GET  /api/access-codes  — the owner's codes, with status and usage.
// POST /api/access-codes  — issue a new code. Returns the plaintext ONCE.
//
// AUTHORISATION. READS use the owner's OWN cookie-scoped session: every row is
//   reachable through the RLS policy `auth.uid() = owner_user_id`, so a bug in
//   this file cannot list another owner's codes. WRITES do not: signed-in users
//   have no INSERT or UPDATE on access_codes at all (migration 20261008030001),
//   so minting goes through the service-role function mint_access_code, called
//   here only AFTER the caller is authenticated, same-origin and a real owner.
//   That is what lets the database itself refuse a demo, enforce the live-code
//   and daily caps atomically, and store only a keyed hash.
//
// The explicit `.eq('owner_user_id', user.id)` on every read is belt to that
// braces, the same doubling lib/resume/store.ts uses.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isSameOriginRequest } from '@/lib/security/same-origin'
import {
  ACCESS_CODE_TTL_HOURS,
  accessCodeExpiry,
  accessCodePrefix,
  generateAccessCode,
  hashAccessCode,
} from '@/lib/access/codes'
import { isDemoProfile, type DemoProfileFacts } from '@/lib/access/guardrails'
import { ACCESS_CODE_COLUMNS, summarizeAccessCode, type AccessCodeRow } from './contract'
import { NO_STORE } from './http'

export const dynamic = 'force-dynamic'

/** Longest label we store. Long enough for "Acme — Thursday 2pm walkthrough". */
const MAX_LABEL_CHARS = 120

/** Most codes shown in the list. Far above any real use; a guard, not a policy. */
const MAX_LISTED = 200

/**
 * How many codes may be live (unexpired and unrevoked) at once.
 *
 * Not arbitrary: every live code can mint a real demo workspace that burns real
 * model spend, and an unbounded list is also unreadable — which defeats the
 * point of a feature whose job is showing the owner what happened. Expired and
 * revoked codes do not count, so the cap never blocks someone who has simply
 * been demoing for months. If this ever bites a legitimate user, raise it
 * deliberately; do not remove it.
 */
const MAX_LIVE_CODES = 25

/** How many times to retry a code_hash collision before giving up. */
const INSERT_ATTEMPTS = 3

/**
 * What mint_access_code raises for a demo owner (or one it cannot read), as
 * PostgREST reports it: `insufficient_privilege` (SQLSTATE 42501), passed through
 * as `error.code`. Recognising it turns the database's refusal into the same 403
 * the application check above already returns, instead of a 500 that reads as
 * "our bug" and invites a retry. The two checks are deliberately independent:
 * this is the backstop for the window between reading the profile and minting,
 * and for any future caller that forgets the check entirely.
 */
const INSUFFICIENT_PRIVILEGE = '42501'

/** mint_access_code's cap refusals (live codes, or codes in the last 24 hours). */
const CHECK_VIOLATION = '23514'

const CROSS_SITE = "This request didn't come from Cello. Reload the page and try again."

/** The refusal both the application check and the database trigger produce. */
const DEMO_CANNOT_ISSUE = 'Demo workspaces cannot issue access codes.'
const DAILY_LIMIT = 'You have created a lot of codes in the last day. Try again tomorrow.'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  // access_codes is not in @cello/shared's generated Database type (the
  // migration postdates it), so the query goes through an untyped view of the
  // SAME cookie-scoped client — the pattern app/(app)/resume/page.tsx uses for
  // resume_documents. RLS is unaffected by the cast.
  const db = supabase as unknown as SupabaseClient

  const { data, error } = await db
    .from('access_codes')
    .select(ACCESS_CODE_COLUMNS)
    .eq('owner_user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(MAX_LISTED)

  if (error) {
    console.error('[access-codes] list failed', error)
    return NextResponse.json(
      { error: "Couldn't load your access codes." },
      { status: 500, headers: NO_STORE }
    )
  }

  const now = new Date()
  const codes = ((data ?? []) as AccessCodeRow[]).map((row) => summarizeAccessCode(row, now))

  // What this owner's demos have spent this month, against the monthly pool they
  // all share. Omitted (not zero) when it cannot be read: the card then says
  // nothing rather than something false.
  let demoAllowance: { usedUsd: number; capUsd: number } | null = null
  try {
    const { data: state, error: stateError } = await createAdminClient().rpc('demo_allowance_state', {
      p_owner_id: user.id,
    })
    const row = state as { used_usd?: number; cap_usd?: number } | null
    if (!stateError && row && typeof row.used_usd === 'number' && typeof row.cap_usd === 'number') {
      demoAllowance = { usedUsd: row.used_usd, capUsd: row.cap_usd }
    }
  } catch (err) {
    console.error('[access-codes] demo allowance read failed', err)
  }

  return NextResponse.json(
    { codes, liveLimit: MAX_LIVE_CODES, ttlHours: ACCESS_CODE_TTL_HOURS, demoAllowance },
    { headers: NO_STORE }
  )
}

export async function POST(request: NextRequest) {
  // A cookie-authenticated state change: refuse a request a hostile page made on
  // the owner's behalf.
  if (!isSameOriginRequest(request.headers)) {
    return NextResponse.json({ error: CROSS_SITE }, { status: 403, headers: NO_STORE })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const db = supabase as unknown as SupabaseClient

  // A DEMO SESSION MAY NOT ISSUE CODES.
  //
  // RLS scopes codes to `owner_user_id = auth.uid()`, which a demo profile
  // satisfies for itself — so without this check a visitor handed one 72-hour
  // code could mint more of them, hand those out, and spawn workspace after
  // workspace of real model spend from a single invitation. The check is here
  // rather than in the UI because the UI is not a boundary.
  //
  // Fails closed: if the profile cannot be read we cannot prove the caller is
  // not a demo, and issuing anyway is the wrong way to be wrong. This mirrors
  // the 'profile-unavailable' refusal in lib/access/guardrails.ts.
  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('is_demo, demo_expires_at')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError || !profile) {
    console.error('[access-codes] could not verify the caller is not a demo', profileError)
    return NextResponse.json(
      { error: "We couldn't verify your account, so no code was issued." },
      { status: 403, headers: NO_STORE }
    )
  }
  if (isDemoProfile(profile as DemoProfileFacts)) {
    return NextResponse.json({ error: DEMO_CANNOT_ISSUE }, { status: 403, headers: NO_STORE })
  }

  // A body is optional — "Create demo code" with no label is the common case.
  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const rawLabel = (body as Record<string, unknown>)?.label
  const label =
    typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim().slice(0, MAX_LABEL_CHARS) : null

  const expiresAt = accessCodeExpiry()
  const admin = createAdminClient()

  for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
    const code = generateAccessCode()

    // The caps (live and daily) and the demo refusal are enforced inside the
    // function, atomically, under the owner's lock.
    const { data, error } = await admin.rpc('mint_access_code', {
      p_owner_id: user.id,
      // Only the keyed hash is ever persisted. `code` below leaves this process
      // in the response body and is never written down.
      p_code_hash: hashAccessCode(code),
      p_code_prefix: accessCodePrefix(code),
      p_label: label,
      p_expires_at: expiresAt.toISOString(),
    })

    // 23505 = unique_violation on code_hash. At ~59 bits of entropy this is
    // effectively unreachable, but retrying is cheaper than a mystery 500.
    if (error?.code === '23505' && attempt < INSERT_ATTEMPTS - 1) continue

    // The database refused because the caller is a demo: the same answer the
    // check above gives, reached the other way. Never retried: a refusal is a
    // decision, not a collision.
    if (error?.code === INSUFFICIENT_PRIVILEGE) {
      console.warn('[access-codes] database refused a demo-issued code', error.message)
      return NextResponse.json({ error: DEMO_CANNOT_ISSUE }, { status: 403, headers: NO_STORE })
    }

    if (error?.code === CHECK_VIOLATION) {
      const daily = /24 hours/.test(error.message ?? '')
      return NextResponse.json(
        {
          error: daily
            ? DAILY_LIMIT
            : `You already have ${MAX_LIVE_CODES} live codes. Revoke one you are finished with, or wait for it to expire.`,
        },
        { status: 409, headers: NO_STORE }
      )
    }

    const row = (Array.isArray(data) ? data[0] : data) as AccessCodeRow | null | undefined
    if (error || !row) {
      console.error('[access-codes] create failed', error)
      return NextResponse.json(
        { error: "Couldn't issue a code right now. Try again." },
        { status: 500, headers: NO_STORE }
      )
    }

    return NextResponse.json(
      {
        // THE ONLY TIME THIS VALUE EXISTS OUTSIDE THE HOLDER'S HANDS. It is not
        // stored, not logged, and not recoverable from any later response.
        code,
        ttlHours: ACCESS_CODE_TTL_HOURS,
        summary: summarizeAccessCode(row),
      },
      { status: 201, headers: NO_STORE }
    )
  }

  return NextResponse.json(
    { error: "Couldn't issue a code right now. Try again." },
    { status: 500, headers: NO_STORE }
  )
}
