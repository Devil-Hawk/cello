// GET  /api/access-codes  — the owner's codes, with status and usage.
// POST /api/access-codes  — issue a new code. Returns the plaintext ONCE.
//
// AUTHORISATION: the owner's OWN cookie-scoped session, never the service key.
//   Every row here is reachable through RLS policies that already say
//   `auth.uid() = owner_user_id` (see 20260803000002_access_codes.sql), so the
//   session is both sufficient and safer: a bug in this file cannot reach
//   another owner's codes, because the database refuses. The service key is
//   reserved for writing access_code_events, which has no insert policy on
//   purpose so a demo session cannot forge or suppress its own trail.
//
// The explicit `.eq('owner_user_id', user.id)` on every query is belt to that
// braces — the same doubling lib/resume/store.ts uses. If RLS were ever
// mis-applied to this table, these routes would still be scoped.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
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
 * What the demo-chaining trigger raises, as PostgREST reports it.
 *
 * 20260803000003_demo_profile_lockdown.sql's forbid_demo_access_code_issue()
 * raises `insufficient_privilege` (SQLSTATE 42501) on insert. PostgREST passes
 * the SQLSTATE through as `error.code`, and supabase-js hands it to us
 * unchanged. Recognising it turns the database's refusal into the same 403 the
 * application check above already returns, instead of a 500 that reads as "our
 * bug" and invites a retry. The two checks are deliberately independent: this
 * is the backstop for the window between reading the profile and inserting the
 * row, and for any future caller that forgets the check entirely.
 */
const INSUFFICIENT_PRIVILEGE = '42501'

/** The refusal both the application check and the database trigger produce. */
const DEMO_CANNOT_ISSUE = 'Demo workspaces cannot issue access codes.'

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

  return NextResponse.json(
    { codes, liveLimit: MAX_LIVE_CODES, ttlHours: ACCESS_CODE_TTL_HOURS },
    { headers: NO_STORE }
  )
}

export async function POST(request: NextRequest) {
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

  // Count what is currently live. `head: true` so this costs a count, not rows.
  const { count, error: countError } = await db
    .from('access_codes')
    .select('id', { count: 'exact', head: true })
    .eq('owner_user_id', user.id)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())

  if (countError) {
    console.error('[access-codes] live count failed', countError)
    return NextResponse.json(
      { error: "Couldn't issue a code right now. Try again." },
      { status: 500, headers: NO_STORE }
    )
  }
  // Fail closed on an unreadable count: without a number we cannot say the cap
  // is respected, and issuing anyway is the wrong way to be wrong.
  if (typeof count !== 'number') {
    console.error('[access-codes] live count returned no number')
    return NextResponse.json(
      { error: "Couldn't issue a code right now. Try again." },
      { status: 500, headers: NO_STORE }
    )
  }
  if (count >= MAX_LIVE_CODES) {
    return NextResponse.json(
      {
        error: `You already have ${MAX_LIVE_CODES} live codes. Revoke one you are finished with, or wait for it to expire.`,
      },
      { status: 409, headers: NO_STORE }
    )
  }

  const expiresAt = accessCodeExpiry()

  for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
    const code = generateAccessCode()

    const { data, error } = await db
      .from('access_codes')
      .insert({
        owner_user_id: user.id,
        // Only the hash is ever persisted. `code` below leaves this process in
        // the response body and is never written down.
        code_hash: hashAccessCode(code),
        code_prefix: accessCodePrefix(code),
        label,
        expires_at: expiresAt.toISOString(),
      })
      .select(ACCESS_CODE_COLUMNS)
      .single()

    // 23505 = unique_violation on code_hash. At ~59 bits of entropy this is
    // effectively unreachable, but retrying is cheaper than a mystery 500.
    if (error?.code === '23505' && attempt < INSERT_ATTEMPTS - 1) continue

    // The database refused because the caller is a demo — the same answer the
    // check above gives, reached the other way. Never retried: a trigger's
    // refusal is a decision, not a collision, and retrying it would just be
    // three round trips to the same 403.
    if (error?.code === INSUFFICIENT_PRIVILEGE) {
      console.warn('[access-codes] database refused a demo-issued code', error.message)
      return NextResponse.json({ error: DEMO_CANNOT_ISSUE }, { status: 403, headers: NO_STORE })
    }

    if (error || !data) {
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
        summary: summarizeAccessCode(data as AccessCodeRow),
      },
      { status: 201, headers: NO_STORE }
    )
  }

  return NextResponse.json(
    { error: "Couldn't issue a code right now. Try again." },
    { status: 500, headers: NO_STORE }
  )
}
