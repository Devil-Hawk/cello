// Needs you: one list of what waits on the person, with one row per target. Today, the bell, the
// phone badge, the tab title and the email all read it. This file is the shape and the order, pushed
// first so Today and Chat can build on it; lib/needs-you/index.ts fills it.

import type { SupabaseClient } from '@supabase/supabase-js'

/** Every kind of row. A kind a lane adds goes through `kinds/<lane>.ts`. */
export const NEEDS_YOU_KINDS = [
  // from the pipeline (applications.state and needs_reason)
  'ready',
  'approve_resume',
  'answer',
  'duplicate',
  'your_turn',
  'check_sent',
  'reconnect',
  'budget',
  'wait_computer',
  // from the search, computed by nextStep
  'reply',
  'offer_due',
  'follow_up_due',
  'gone_quiet',
  // from mail and the network
  'stage_confirm',
  'confirm_found',
  'mail_to_sort',
  'nudge',
  // others
  'approve_email',
  'setup',
  'connection_lost',
  'limit_reached',
  'proposals',
  'owner_gate',
] as const
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number]

/** The order the list reads in (4.4): due within 48 hours, replies, stage confirmations, approvals, ready to send, the site needs you, follow-ups, questions, mail to sort, setup. */
export const NEEDS_YOU_GROUPS = [
  'due',
  'reply',
  'stage',
  'approval',
  'ready',
  'site',
  'follow_up',
  'question',
  'mail',
  'setup',
] as const
export type NeedsYouGroup = (typeof NEEDS_YOU_GROUPS)[number]

/** What a row is about. One row per target, never two. */
export interface NeedsYouTarget {
  kind: 'application' | 'role' | 'person' | 'question' | 'company' | 'account'
  id: string
}

/** The button of a row: the command it runs and what it is given. */
export interface NeedsYouButton {
  label: string
  /** A registry command id, or a route the button opens. */
  command: string
  args?: Record<string, unknown>
}

export interface NeedsYouRow {
  /** Stable for the same target and kind, so a row keeps its place between reads. */
  id: string
  kind: NeedsYouKind
  group: NeedsYouGroup
  target: NeedsYouTarget
  companyId: string | null
  companyName: string | null
  logoUrl: string | null
  roleTitle: string | null
  /** One plain sentence for the person. */
  sentence: string
  /** When it is due, if it has a date. A row due within 48 hours leads the list. */
  dueAt: string | null
  button: NeedsYouButton
  /** How many the badge counts for this row: each application in a grouped ready row, one for any other. */
  count: number
  /** The rows a grouped row stands for (the ready row, an answer shared by several applications). */
  members: NeedsYouRow[]
}

export interface NeedsYouContext {
  client: SupabaseClient
  userId: string
  now: Date
}

/** A lane's source of rows. `kinds/<lane>.ts` exports a list of these. */
export interface NeedsYouKindSource {
  kinds: readonly NeedsYouKind[]
  load: (ctx: NeedsYouContext) => Promise<NeedsYouRow[]>
}

export interface NeedsYouList {
  rows: NeedsYouRow[]
  /** The badge, the tab title and the email: each application in the ready row, and every other row once. */
  count: number
}
