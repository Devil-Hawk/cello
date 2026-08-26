// POST /api/gmail/sync — mine the signed-in user's Gmail for job-application
// correspondence and turn it into companies/jobs/applications/activities/
// follow_ups. This route is now a thin session-authed wrapper: auth, the
// "monitor" permission gate, and access-token resolution live here; the
// actual DB-orchestrating pipeline (pure text-matching + classification logic
// lives in lib/gmail/*, owned alongside this route) is
// lib/gmail/sync-core.ts#runGmailSyncCore — a pure move, so
// app/api/gmail/cron/route.ts can drive the identical logic for every user
// with "monitor" enabled on a schedule, with the admin client + a stored
// refresh token, instead of only on a dashboard button click.
//
// Fixes sync-core.ts applies (see BUILDER-4 task list):
//  1. No more arbitrary `.limit(1)` job attachment — jobs are matched by
//     title similarity (lib/gmail/matching.ts) above a confidence threshold,
//     or a clearly-labelled placeholder job is created from the ACTUAL parsed
//     title. If neither is possible, nothing is attached (see `unmatched`).
//  2. No more inventing tracked companies from arbitrary senders. Applications
//     are only attached to companies the user already tracks (matched by
//     domain, then normalized name). An unrecognized-but-plausible employer is
//     recorded as a `metadata: {suggested:true, source:'gmail'}` company for
//     the user to confirm — never with a fabricated career_url.
//  3. Sender skip list now also excludes ATS/job-board/aggregator domains
//     (lib/gmail/skip-lists.ts) from being used as the employer identity —
//     the real employer is parsed out of the subject/body/display-name
//     instead (lib/gmail/employer.ts).
//  4. Every classified email that resolves to an application gets an
//     `activities` row (this was completely missing before). Idempotent:
//     re-running sync dedupes on `metadata->>'gmail_message_id'`.
//  5. Interview/screen emails get their date/time extracted (LLM first, regex
//     fallback) and produce a `follow_ups` reminder due before the interview.
//  6. Stage transitions go through lib/gmail/stage.ts: rejection is allowed
//     from any non-terminal stage, terminal stages are never silently
//     regressed, and every decision (including "ignored") is recorded on the
//     activity row's metadata.
//  7. The Gmail search query is tightened (lib/gmail/gmail-api.ts) and the
//     response includes `unmatched` so the UI can show what couldn't be
//     classified/attached instead of the route guessing silently.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDecryptedApiKeys } from '@/lib/apikeys'
import { hasGmailPermission } from '@/lib/gmail/permissions'
import { getGmailAccessToken } from '@/lib/gmail/token'
import { runGmailSyncCore } from '@/lib/gmail/sync-core'
import { logApiError } from '@/lib/observability/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: { session } } = await supabase.auth.getSession()

  // Get sync state / permissions from preferences (read once, reused below —
  // the permission gate needs it before we even look at provider_token).
  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, unknown>

  // "Monitor mailbox" is its own opt-in tier now (see lib/gmail/permissions),
  // separate from "send" and "read selected shared threads" — a user who
  // hasn't turned this on shouldn't have Cello scanning their inbox just
  // because a Google session happens to exist.
  if (!hasGmailPermission(preferences, 'monitor')) {
    return NextResponse.json({
      error: 'Gmail monitoring isn\'t turned on. Enable "Monitor mailbox" under Settings → Connections to let Cello scan your inbox for application updates.',
      needsPermission: 'monitor',
      // Also surfaced as needsReauth so existing callers (e.g. the dashboard
      // Gmail sync card) route the user to the same Settings → Connections
      // destination they already know, with the calmer "not connected" tone
      // rather than a red error — this is an unmet precondition, not a fault.
      needsReauth: true,
    }, { status: 403 })
  }

  // A stored refresh token (captured at the OAuth callback that granted
  // "monitor", see app/auth/callback/route.ts) is what makes this work
  // without a live browser tab — the session's own provider_token is dead
  // within about an hour and Supabase never refreshes it in the background.
  // Prefer it; fall back to the session token for a fresh interactive click
  // that hasn't round-tripped through the callback's persistence yet.
  const tokenResult = await getGmailAccessToken(supabase, user.id, preferences)
  // Only fall back to the session's own provider_token when we've never
  // captured a refresh token at all (`not_connected` — a fresh interactive
  // click before the callback's persistence has round-tripped). On
  // `invalid_grant` the self-heal inside getGmailAccessToken has already
  // disabled monitor honestly; completing this one request anyway on a
  // token Google may be revoking at the same moment would blur that signal.
  const accessToken = tokenResult.ok
    ? tokenResult.accessToken
    : tokenResult.reason === 'not_connected'
      ? session?.provider_token || null
      : null

  if (!accessToken) {
    // tokenResult.ok is necessarily false here (a true result always yields a
    // token) — but narrowing on it rather than asserting keeps this honest if
    // that ever changes.
    const message = !tokenResult.ok && tokenResult.reason !== 'not_connected'
      ? tokenResult.message
      : 'Gmail access not available. Connect Gmail in Settings to enable this.'
    return NextResponse.json({ error: message, needsReauth: true }, { status: 401 })
  }

  // Get API keys for AI parsing (regex fallback is used when absent).
  const apiKeys = await getDecryptedApiKeys(user.id)

  try {
    const result = await runGmailSyncCore({
      db: supabase,
      userId: user.id,
      accessToken,
      apiKeys,
      preferences,
    })
    return NextResponse.json(result)

  } catch (error) {
    // Structured + (if configured) Sentry-reported — see logApiError's own
    // doc. `extra` is IDs only: never the email/company/job content this
    // route processes.
    logApiError('gmail/sync', error, { userId: user.id })
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to sync Gmail'
    }, { status: 500 })
  }
}
