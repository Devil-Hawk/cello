// inbox.sync: read each connected person's mail, one person at a time, each with a heartbeat of its own
// (so "hours since the last successful mail read" is true per person, measure T6). The hourly routine
// and the Gmail cron route both call this; there is one place that decides who is eligible and how
// one person is read.
//
// ponytail: the two classify steps (inbox.classify, inbox.employer) are the model call inside
// parseEmailWithAI today; they become defineModelStep steps once K11 is on main.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadApiKeys } from '@/lib/harness/keys'
import { mapWithConcurrency } from '@/lib/ats/concurrency'
import { withTimeout } from '@/lib/security/untrusted'
import { logApiError } from '@/lib/observability/log'
import { getGmailAccessToken } from './token'
import { hasGmailPermission } from './permissions'
import { runGmailSyncCore } from './sync-core'
import type { SyncState } from './types'

export const MAX_USERS_PER_TICK = 10
const USER_CONCURRENCY = 2
// ponytail: a fixed per-person ceiling, not a fair scheduler; raise it or queue per person if mailboxes need longer.
const PER_USER_BUDGET_MS = 20_000

export interface InboxUserResult {
  userId: string
  /** Why this tick did nothing for this person: a token-mint failure reason, never a thrown error. */
  tokenIssue?: string
  processed?: number
  isFirstSync?: boolean
  error?: string
}

interface ProfileRow {
  id: string
  preferences: Record<string, unknown> | null
}

/** One heartbeat per person and job: update the row, or make it (the unique index is on an expression). */
async function beat(admin: SupabaseClient, userId: string, patch: Record<string, unknown>): Promise<void> {
  const { data } = await admin.from('job_heartbeats').update(patch).eq('job', 'inbox.sync').eq('user_id', userId).select('job')
  if (!data || data.length === 0) await admin.from('job_heartbeats').insert({ job: 'inbox.sync', user_id: userId, ...patch })
}

/** Read one person's mail. Never throws: a failure is the result, and the heartbeat says so. */
export async function syncInbox(admin: SupabaseClient, profile: ProfileRow): Promise<InboxUserResult> {
  const preferences = profile.preferences || {}
  const started = new Date()
  await beat(admin, profile.id, { started_at: started.toISOString() }).catch(() => undefined)
  try {
    const tokenResult = await getGmailAccessToken(admin, profile.id, preferences)
    if (!tokenResult.ok) {
      // invalid_grant is already healed by getGmailAccessToken (monitor off, token cleared)
      await beat(admin, profile.id, { failure: tokenResult.reason }).catch(() => undefined)
      return { userId: profile.id, tokenIssue: tokenResult.reason, error: tokenResult.message }
    }
    const apiKeys = await loadApiKeys(admin, profile.id)
    const result = await withTimeout(
      runGmailSyncCore({ db: admin, userId: profile.id, accessToken: tokenResult.accessToken, apiKeys, preferences }),
      PER_USER_BUDGET_MS,
      `gmail sync for ${profile.id}`,
    )
    await beat(admin, profile.id, { succeeded_at: new Date().toISOString(), failure: null, duration_ms: Date.now() - started.getTime(), found: { read: result.processed, applications: result.createdApplications.length } }).catch(() => undefined)
    return { userId: profile.id, processed: result.processed, isFirstSync: result.isFirstSync }
  } catch (e) {
    logApiError('gmail/inbox', e, { userId: profile.id })
    await beat(admin, profile.id, { failure: 'sync_failed' }).catch(() => undefined)
    return { userId: profile.id, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Everyone whose "monitor" grant is on and whose refresh token is stored, read a few at a time. */
export async function syncAllInboxes(admin: SupabaseClient): Promise<{ ok: true; eligibleUsers: number; processed: number; results: InboxUserResult[] } | { ok: false; error: string }> {
  const { data: profiles, error } = await admin.from('profiles').select('id, preferences')
  if (error) return { ok: false, error: error.message }
  // A live grant with no stored refresh token (a session-only connect) has nothing to act on here.
  const eligible = ((profiles ?? []) as ProfileRow[]).filter((p) => {
    const preferences = p.preferences || {}
    return hasGmailPermission(preferences, 'monitor') && !!((preferences.gmail_sync || {}) as SyncState).refreshToken
  })
  const batch = eligible.slice(0, MAX_USERS_PER_TICK)
  const results = await mapWithConcurrency(batch, USER_CONCURRENCY, (p) => syncInbox(admin, p))
  return { ok: true, eligibleUsers: eligible.length, processed: batch.length, results }
}
