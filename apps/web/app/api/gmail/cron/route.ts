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
import { syncAllInboxes } from '@/lib/gmail/inbox'
import { isCronAuthorized } from '@/lib/security/shared-secret'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The batch cap, the worker pool and the per-person budget live with the one reader, lib/gmail/inbox.ts.
export async function POST(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const r = await syncAllInboxes(createAdminClient())
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 500 })
  return NextResponse.json({ ok: true, eligibleUsers: r.eligibleUsers, processed: r.processed, results: r.results })
}
