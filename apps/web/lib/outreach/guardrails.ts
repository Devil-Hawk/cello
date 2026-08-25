// Non-negotiable outreach guardrails, in one auditable place.
//
//  (1) approve-queue by DEFAULT — nothing sends unless it is 'approved', OR the
//      user explicitly enabled preferences.outreach.autoSend.
//  (2) daily cap (default 10) — stay well under Gmail limits, avoid spammy volume.
//  (3) one email per contact per role — hard dedupe (see store.findDuplicateInitial).
//  (4) real identity only — send is always From the authenticated Gmail account.
//  (5) a single polite follow-up, only after N days with no reply.

import type { OutreachMessageRow, OutreachPreferences } from './types'

export interface Gate {
  allowed: boolean
  reason?: string
}

export interface SendIntent {
  /**
   * True when a human is approving this message IN THE SAME REQUEST that sends
   * it, rather than having approved it earlier as a separate persisted step.
   *
   * This exists to close an arming bug. The queue UI used to PATCH the message
   * to 'approved' and THEN post to the send route; when the send leg failed on
   * a permission or daily-cap check the row was already 'approved', and the
   * `approved` branch below returns allowed unconditionally, forever, with no
   * second look at whether the send ever happened. The user saw a red error
   * toast, reasonably believed nothing had happened, and had in fact armed a
   * real email to a real person for any later send path.
   *
   * Passing the approval as an argument instead makes approve-and-send atomic:
   * a failed send leaves the row 'pending_review', exactly where it started.
   */
  humanApproved?: boolean
}

/** Guardrail (1): may this drafted message be sent right now? */
export function canSendNow(
  message: OutreachMessageRow,
  prefs: OutreachPreferences,
  intent: SendIntent = {}
): Gate {
  if (message.status === 'sent') return { allowed: false, reason: 'already sent' }
  if (message.status === 'skipped' || message.status === 'failed') {
    return { allowed: false, reason: `message is ${message.status}` }
  }
  if (message.status === 'approved') return { allowed: true }
  if (message.status === 'pending_review') {
    // An explicit human approval arriving with the send request satisfies this
    // guardrail on its own — that IS the approval the queue exists to collect.
    if (intent.humanApproved) return { allowed: true }
    return prefs.autoSend
      ? { allowed: true }
      : { allowed: false, reason: 'awaiting approval (auto-send is disabled)' }
  }
  return { allowed: false, reason: `unexpected status: ${message.status}` }
}

/** Guardrail (2): daily-cap gate given today's sent count. */
export function checkDailyCap(sentToday: number, prefs: OutreachPreferences): Gate {
  if (sentToday >= prefs.dailyCap) {
    return { allowed: false, reason: `daily cap reached (${sentToday}/${prefs.dailyCap})` }
  }
  return { allowed: true }
}

/** Guardrail (5): is a single follow-up eligible yet (time window only)? */
export function followUpWindowElapsed(
  parentSentAt: string | null,
  prefs: OutreachPreferences,
  now = new Date()
): Gate {
  if (!parentSentAt) return { allowed: false, reason: 'parent was never sent' }
  const sentMs = new Date(parentSentAt).getTime()
  // Fail CLOSED on an unreadable timestamp. Every comparison against NaN is
  // false, so without this guard `elapsedMs < needMs` below is false and the
  // function falls through to `{ allowed: true }` — a malformed sent_at would
  // become instant permission to chase a reply. Caught by guardrails.test.ts.
  if (!Number.isFinite(sentMs)) {
    return { allowed: false, reason: 'parent send time is unreadable' }
  }
  const elapsedMs = now.getTime() - sentMs
  const needMs = prefs.followUpDays * 24 * 60 * 60 * 1000
  if (elapsedMs < needMs) {
    const daysLeft = Math.ceil((needMs - elapsedMs) / (24 * 60 * 60 * 1000))
    return { allowed: false, reason: `follow-up window not elapsed (${daysLeft}d left)` }
  }
  return { allowed: true }
}
