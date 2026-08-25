// Daily-digest runner — Pattern B (NOT a registered harness agent_type).
//
// The DAG executor never calls this; it is the shared, testable core that the
// daily cron (app/api/harness/cron) invokes once per active user, and that the
// request-context send route (app/api/digest/send) reuses for the actual Gmail
// send.
//
// Constraint: sendGmailMessage needs session.provider_token, which is ONLY
// available in a request context. The cron path has NO token, so it degrades to
// compose-and-store (persist the digest to profiles.preferences.digest.latest so
// the user can read it in-app / from /api/digest). A real email send happens via
// /api/digest/send (request context) or is simply a no-op here in cron.

import type { SupabaseClient } from '@supabase/supabase-js'
import { composeDigest } from '@/lib/digest/compose'
import {
  resolveDigestPreferences,
  utcDateKey,
  type ComposedDigest,
} from '@/lib/digest/types'

export type DigestOutcome = 'sent' | 'stored' | 'skipped_disabled' | 'skipped_already' | 'error'

export interface DigestRunResult {
  userId: string
  outcome: DigestOutcome
  reason?: string
  empty?: boolean
}

/** Optional best-effort sender (request context supplies one; cron does not). */
export type DigestSender = (digest: ComposedDigest) => Promise<void>

export interface ComposeAndStoreOptions {
  /** Ignore the opt-in flag (e.g. an explicit in-app "send now"). Default false. */
  force?: boolean
  /** If provided, attempt a best-effort send after storing. */
  send?: DigestSender
}

/**
 * Compose today's digest for one user and persist it under
 * preferences.digest.latest, enforcing opt-in (preferences.digest.enabled) and
 * once-per-day (preferences.digest.lastSentDate). Never throws — returns a
 * structured outcome so a batch caller can keep going.
 */
export async function composeAndStoreDigest(
  admin: SupabaseClient,
  userId: string,
  opts: ComposeAndStoreOptions = {}
): Promise<DigestRunResult> {
  try {
    const { data: profile } = await admin
      .from('profiles')
      .select('preferences')
      .eq('id', userId)
      .single()

    const preferences = ((profile?.preferences as Record<string, unknown> | null) || {}) as Record<
      string,
      unknown
    >
    const prefs = resolveDigestPreferences(preferences.digest)
    const today = utcDateKey()

    // Opt-in gate (default OFF) — unless an explicit force is requested.
    if (!prefs.enabled && !opts.force) {
      return { userId, outcome: 'skipped_disabled' }
    }
    // Once-per-day gate.
    if (prefs.lastSentDate === today && !opts.force) {
      return { userId, outcome: 'skipped_already' }
    }

    const digest = await composeDigest(admin, userId)

    // Best-effort send (only if a sender was supplied — cron supplies none).
    let outcome: DigestOutcome = 'stored'
    if (opts.send) {
      try {
        await opts.send(digest)
        outcome = 'sent'
      } catch (e) {
        // Storing still succeeds; report the send failure without throwing.
        return persistAndReturn(admin, userId, preferences, digest, today, {
          userId,
          outcome: 'stored',
          reason: e instanceof Error ? e.message : 'send failed',
          empty: digest.empty,
        })
      }
    }

    return persistAndReturn(admin, userId, preferences, digest, today, {
      userId,
      outcome,
      empty: digest.empty,
    })
  } catch (e) {
    return { userId, outcome: 'error', reason: e instanceof Error ? e.message : String(e) }
  }
}

async function persistAndReturn(
  admin: SupabaseClient,
  userId: string,
  preferences: Record<string, unknown>,
  digest: ComposedDigest,
  today: string,
  result: DigestRunResult
): Promise<DigestRunResult> {
  const existingDigest = (preferences.digest as Record<string, unknown> | undefined) || {}
  const nextPreferences = {
    ...preferences,
    digest: {
      ...existingDigest,
      latest: digest,
      lastSentDate: today,
    },
  }
  const { error } = await admin
    .from('profiles')
    .update({ preferences: nextPreferences })
    .eq('id', userId)
  if (error) {
    return { ...result, outcome: 'error', reason: error.message }
  }
  return result
}
