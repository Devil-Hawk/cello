// POST /api/access-codes/:id/revoke — turn a code off, now.
//
// Revocation is independent of expiry (see the migration's header): a code the
// owner regrets must stop working immediately, without waiting out its 72
// hours. The demo workspace and its audit trail are deliberately NOT touched —
// "what did they do with that code" is usually asked after it has been shut
// off, and deleting the answer along with the access would defeat the feature.
//
// Scoped by the owner's own session, so RLS refuses another owner's row even if
// the id is guessed. The service key is used for exactly one extra write, and
// only after that ownership is proven: ending the demo session that was already
// minted from the code (see endDemoSession). See ../../route.ts for why it is
// not used for anything else.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { ACCESS_CODE_COLUMNS, summarizeAccessCode, type AccessCodeRow } from '../../contract'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { NO_STORE, isUuid } from '../../http'

export const dynamic = 'force-dynamic'

const REVOKE_FAILED = "Couldn't revoke that code. Try again."

/**
 * Revoking only stops NEW redemptions. A demo that already redeemed holds a
 * normal session that the middleware and the key guards gate on
 * profiles.demo_expires_at alone, so without this it would keep spending the
 * owner's key until its 72 hours ran out. Pulling the deadline to now ends it
 * (within the middleware's 60 second facts cache).
 *
 * demo_user_id comes from the database row the owner's session just proved is
 * theirs, never from the request, and `is_demo = true` means a non-demo profile
 * (including the owner's) can never be expired here. Idempotent: running it
 * again on an already-revoked code just re-stamps now(). Returns false on any
 * failure so the caller answers 500 and a retry takes the already-revoked path.
 */
async function endDemoSession(db: SupabaseClient, codeId: string, ownerId: string): Promise<boolean> {
  const { data: row, error } = await db
    .from('access_codes')
    .select('demo_user_id')
    .eq('id', codeId)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (error) {
    console.error('[access-codes] revoke could not read the demo user', error)
    return false
  }
  const demoUserId = (row as { demo_user_id?: string | null } | null)?.demo_user_id
  if (!demoUserId) return true // never redeemed: no session exists

  try {
    const { error: endError } = await createAdminClient()
      .from('profiles')
      .update({ demo_expires_at: new Date().toISOString() })
      .eq('id', demoUserId)
      .eq('is_demo', true)
    if (endError) throw endError
    return true
  } catch (err) {
    console.error('[access-codes] revoke could not end the demo session', err)
    return false
  }
}

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
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

  // `.is('revoked_at', null)` makes this idempotent WITHOUT rewriting history:
  // re-revoking must not move the timestamp, because that timestamp is the
  // record of when access actually stopped.
  const { data: revoked, error } = await db
    .from('access_codes')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', params.id)
    .eq('owner_user_id', user.id)
    .is('revoked_at', null)
    .select(ACCESS_CODE_COLUMNS)
    .maybeSingle()

  if (error) {
    console.error('[access-codes] revoke failed', error)
    return NextResponse.json({ error: REVOKE_FAILED }, { status: 500, headers: NO_STORE })
  }

  if (revoked) {
    if (!(await endDemoSession(db, params.id, user.id))) {
      return NextResponse.json({ error: REVOKE_FAILED }, { status: 500, headers: NO_STORE })
    }
    return NextResponse.json(
      { code: summarizeAccessCode(revoked as AccessCodeRow), alreadyRevoked: false },
      { headers: NO_STORE }
    )
  }

  // No row updated: either the code was already revoked, or it is not this
  // owner's (RLS filtered it), or it does not exist. Re-read under the same
  // scope to tell the first case from the other two.
  const { data: existing, error: readError } = await db
    .from('access_codes')
    .select(ACCESS_CODE_COLUMNS)
    .eq('id', params.id)
    .eq('owner_user_id', user.id)
    .maybeSingle()

  if (readError) {
    console.error('[access-codes] revoke re-read failed', readError)
    return NextResponse.json({ error: REVOKE_FAILED }, { status: 500, headers: NO_STORE })
  }

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE })
  }

  // Already off. A second click is a success, not an error, and it re-runs the
  // session cutoff in case the first attempt revoked the code but failed there.
  if (!(await endDemoSession(db, params.id, user.id))) {
    return NextResponse.json({ error: REVOKE_FAILED }, { status: 500, headers: NO_STORE })
  }
  return NextResponse.json(
    { code: summarizeAccessCode(existing as AccessCodeRow), alreadyRevoked: true },
    { headers: NO_STORE }
  )
}
