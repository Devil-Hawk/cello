// POST /api/gmail/cron — the scheduled half of Gmail sync: for every user
// with "monitor" enabled AND a stored refresh token (see lib/gmail/token.ts's
// header — that token is the only thing that makes sync possible outside an
// active browser tab), run the exact same per-user pipeline the dashboard's
// "Sync now" button does (lib/gmail/sync-core.ts#runGmailSyncCore) — reuse,
// not a fork. This is what turns Gmail sync into something that actually
// runs, instead of something that only ran when a user remembered to click a
// card.
//
// Guarded by CRON_SECRET, same idiom as app/api/harness/{autopilot,cron}/
// route.ts: caller presents it as `Authorization: Bearer <secret>` or
// `X-Cron-Secret: <secret>`. Batch cap + concurrency mirror autopilot's own
// constants idiom (lib/graph/autopilot.ts's MAX_USERS_PER_TICK/
// USER_CONCURRENCY) rather than inventing a new shape.
//
// A demo profile can never appear in the eligible set: the demo lockdown
// trigger (supabase/migrations/20260803000003) refuses any write to the
// `gmail_sync` preferences key, so a demo's refreshToken can never be
// persisted in the first place (see app/auth/callback/route.ts's own header)
// — nothing here needs to re-check that.
//
// invalid_grant (a revoked Google grant) is handled by lib/gmail/token.ts's
// own self-heal: getGmailAccessToken flips "monitor" off and clears the dead
// token in the same write the moment Google refuses the refresh, so a
// revoked user simply stops being eligible on the NEXT tick — this route
// does not duplicate that logic, only surfaces the failure for this tick.
//
// Invoked by .github/workflows/gmail-cron.yml.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { getGmailAccessToken } from '@/lib/gmail/token'
import { hasGmailPermission } from '@/lib/gmail/permissions'
import { runGmailSyncCore } from '@/lib/gmail/sync-core'
import { mapWithConcurrency } from '@/lib/ats/concurrency'
import { withTimeout } from '@/lib/security/untrusted'
import { logApiError } from '@/lib/observability/log'
import type { SyncState } from '@/lib/gmail/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Mirrors lib/graph/autopilot.ts's MAX_USERS_PER_TICK/USER_CONCURRENCY idiom
// — a small per-tick cap plus a small worker pool, not "every eligible user
// at once". A user not reached this tick is simply picked up on the next one;
// nothing about it is lost (scannedEmailIds is the durable cursor).
const MAX_USERS_PER_TICK = 10
const USER_CONCURRENCY = 2

// Per-user wall-clock budget inside this route's own maxDuration=60s. Chosen
// so USER_CONCURRENCY=2 workers clearing MAX_USERS_PER_TICK=10 users in the
// worst case (5 sequential waves) stays close to the route deadline without
// one slow mailbox starving every other user's turn this tick.
// ponytail: a fixed per-user ceiling, not a fair scheduler — raise this (or
// add a real queue) if mailboxes routinely need longer than one tick.
const PER_USER_BUDGET_MS = 20_000

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = request.headers.get('authorization')
  const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
  const header = request.headers.get('x-cron-secret')
  return bearer === secret || header === secret
}

interface ProfileRow {
  id: string
  preferences: Record<string, unknown> | null
}

interface CronUserResult {
  userId: string
  /** Why this tick did nothing for this user — a token-mint failure reason, never a thrown error. */
  tokenIssue?: string
  processed?: number
  isFirstSync?: boolean
  error?: string
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const { data: profiles, error } = await admin.from('profiles').select('id, preferences')
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  // Eligible = "monitor" is on AND a refresh token is actually stored — the
  // second half is what step 1 of this feature added: a live gmail_permissions
  // grant with nothing to exchange it for (a session-only connect that never
  // round-tripped through the OAuth callback's persistence) has nothing this
  // route can act on and is left for the click path.
  const eligible = ((profiles ?? []) as ProfileRow[]).filter((p) => {
    const preferences = p.preferences || {}
    if (!hasGmailPermission(preferences, 'monitor')) return false
    const syncState = (preferences.gmail_sync || {}) as SyncState
    return !!syncState.refreshToken
  })

  const batch = eligible.slice(0, MAX_USERS_PER_TICK)

  const results = await mapWithConcurrency(batch, USER_CONCURRENCY, async (profile): Promise<CronUserResult> => {
    const preferences = profile.preferences || {}
    try {
      const tokenResult = await getGmailAccessToken(admin, profile.id, preferences)
      if (!tokenResult.ok) {
        // invalid_grant already self-healed (monitor off, token cleared) by
        // getGmailAccessToken itself — nothing more to do for this user this
        // tick beyond reporting why it was skipped.
        return { userId: profile.id, tokenIssue: tokenResult.reason, error: tokenResult.message }
      }

      const apiKeys = await loadApiKeys(admin, profile.id)
      const result = await withTimeout(
        runGmailSyncCore({
          db: admin,
          userId: profile.id,
          accessToken: tokenResult.accessToken,
          apiKeys,
          preferences,
        }),
        PER_USER_BUDGET_MS,
        `gmail sync for ${profile.id}`
      )
      return { userId: profile.id, processed: result.processed, isFirstSync: result.isFirstSync }
    } catch (e) {
      logApiError('gmail/cron', e, { userId: profile.id })
      return { userId: profile.id, error: e instanceof Error ? e.message : String(e) }
    }
  })

  return NextResponse.json({ ok: true, eligibleUsers: eligible.length, processed: batch.length, results })
}
