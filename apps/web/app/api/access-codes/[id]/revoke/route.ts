// POST /api/access-codes/:id/revoke: turn a code off, now, and end its session.
//
// Revocation is independent of expiry (see the migration's header): a code the
// owner regrets must stop working immediately, without waiting out its 72 hours.
// The demo workspace and its audit trail are deliberately NOT touched: "what did
// they do with that code" is usually asked after it has been shut off, and
// deleting the answer along with the access would defeat the feature.
//
// HOW IT ENDS A SESSION THAT ALREADY EXISTS
//   Signed-in users cannot write access_codes (migration 20261006002001), so this
//   calls revoke_access_code with the service role, after the caller is
//   authenticated, same-origin and a real owner. That one transaction sets
//   revoked_at AND pulls the demo profile's deadline to now(), which the
//   middleware reads on every demo request (a demo is never cached there), so
//   the very next request is refused. The route then bans the demo's auth user,
//   which also kills its refresh tokens. If the ban fails the answer is a 500 and
//   a retry takes the already-revoked path, which finishes the job.
//
// Ownership is decided inside the function by (code id, owner id): another
// owner's code, a malformed id and a missing code all answer 404, so this route
// never confirms that a code exists.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isDemoProfile, type DemoProfileFacts } from '@/lib/access/guardrails'
import { isSameOriginRequest } from '@/lib/security/same-origin'
import { ACCESS_CODE_COLUMNS, summarizeAccessCode, type AccessCodeRow } from '../../contract'
import { NO_STORE, isUuid } from '../../http'

export const dynamic = 'force-dynamic'

const REVOKE_FAILED = "Couldn't revoke that code. Try again."
const CROSS_SITE = "This request didn't come from Cello. Reload the page and try again."

/** A ban long enough to be permanent (10 years). The demo user is never reused. */
const BAN_DURATION = '87600h'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
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

  // A malformed id is indistinguishable from someone else's id on purpose: both
  // are "not found", so this route never confirms that a code exists.
  if (!isUuid(params.id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  const db = supabase as unknown as SupabaseClient

  // Only a real owner revokes. Fails closed: a profile that cannot be read cannot
  // be shown not to be a demo.
  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('is_demo, demo_expires_at')
    .eq('id', user.id)
    .maybeSingle()
  if (profileError || !profile || isDemoProfile(profile as DemoProfileFacts)) {
    return NextResponse.json(
      { error: "Demo workspaces can't manage access codes." },
      { status: 403, headers: NO_STORE }
    )
  }

  const admin = createAdminClient()
  const { data, error } = await admin.rpc('revoke_access_code', { p_code_id: params.id, p_owner_id: user.id })
  const result = data as { found?: boolean; revoked?: boolean; demo_user_id?: string | null } | null
  if (error || !result) {
    console.error('[access-codes] revoke failed', error)
    return NextResponse.json({ error: REVOKE_FAILED }, { status: 500, headers: NO_STORE })
  }
  if (!result.found) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  // Kill the demo's refresh tokens. Also on the already-revoked path, so a retry
  // after a failed ban finishes the job.
  if (result.demo_user_id) {
    try {
      const { error: banError } = await admin.auth.admin.updateUserById(result.demo_user_id, {
        ban_duration: BAN_DURATION,
      })
      if (banError) throw banError
    } catch (err) {
      console.error('[access-codes] revoke could not ban the demo user', err)
      return NextResponse.json({ error: REVOKE_FAILED }, { status: 500, headers: NO_STORE })
    }
  }

  const { data: row, error: readError } = await db
    .from('access_codes')
    .select(ACCESS_CODE_COLUMNS)
    .eq('id', params.id)
    .eq('owner_user_id', user.id)
    .maybeSingle()
  if (readError || !row) {
    console.error('[access-codes] revoke re-read failed', readError)
    return NextResponse.json({ error: REVOKE_FAILED }, { status: 500, headers: NO_STORE })
  }

  return NextResponse.json(
    { code: summarizeAccessCode(row as AccessCodeRow), alreadyRevoked: result.revoked !== true },
    { headers: NO_STORE }
  )
}
