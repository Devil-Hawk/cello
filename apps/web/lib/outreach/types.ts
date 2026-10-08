// Cold-outreach domain types (framework-free — safe in request + cron contexts).

/** Why a draft is the standard template and not a written draft. */
export type TemplateReason = 'missing_key' | 'spend_cap' | 'provider_error' | 'unusable_output'

export type OutreachStatus =
  | 'pending_review'
  | 'approved'
  | 'sent'
  | 'failed'
  | 'skipped'

export type OutreachKind = 'initial' | 'follow_up' | 'reply'

/**
 * Coarse polarity for an inbound reply, per supabase/migrations/
 * 20260818000003_outreach_reply_outcome.sql's CHECK constraint. Deliberately
 * NOT the job-application stage vocabulary (ApplicationStatus) — see
 * lib/outreach/reply-classify.ts, the one place a reply is read.
 */
export type ReplyClassification = 'positive' | 'neutral' | 'negative' | 'bounce'

/** Row shape of public.outreach_messages (hand-declared; not in Database type). */
export interface OutreachMessageRow {
  id: string
  user_id: string
  contact_id: string | null
  job_id: string | null
  company_id: string | null
  run_id: string | null
  to_email: string
  to_name: string | null
  subject: string
  body: string
  status: OutreachStatus
  kind: OutreachKind
  parent_id: string | null
  gmail_message_id: string | null
  gmail_thread_id: string | null
  error: string | null
  /** False when the draft is the generic template (no model wrote it). NULL on rows from before this was recorded. */
  used_llm?: boolean | null
  /** Why the text is the standard template: set only when used_llm is false. */
  template_reason?: TemplateReason | null
  /** Langfuse trace and generation of the model call that wrote this draft, and what it first wrote
   *  (kept so an edit can be measured). Null for templates and rows from before these existed. */
  trace_id?: string | null
  observation_id?: string | null
  generated_subject?: string | null
  generated_body?: string | null
  /** The artifact (type message) and version that hold this message's text. Null before the copy reached the row. */
  artifact_id?: string | null
  artifact_version?: number | null
  sent_at: string | null
  /** When an inbound reply was matched to this thread. NULL = no reply yet. */
  replied_at: string | null
  /** Gmail message id of the reply. NULL until replied_at is set. */
  reply_gmail_message_id: string | null
  reply_classification: ReplyClassification | null
  created_at: string
  updated_at: string
}

/** User-configurable outreach policy (profiles.preferences.outreach). */
export interface OutreachPreferences {
  /** Auto-send drafts without an explicit approval step. Default: false. */
  autoSend: boolean
  /** Max emails sent per calendar day (UTC). Default: 10. */
  dailyCap: number
  /** Days to wait before a single follow-up is allowed. Default: 5. */
  followUpDays: number
}

export const DEFAULT_OUTREACH_PREFS: OutreachPreferences = {
  autoSend: false,
  dailyCap: 10,
  followUpDays: 5,
}

export function resolveOutreachPreferences(
  raw: unknown
): OutreachPreferences {
  const p = (raw ?? {}) as Partial<OutreachPreferences>
  const dailyCap =
    typeof p.dailyCap === 'number' && Number.isFinite(p.dailyCap)
      ? Math.min(50, Math.max(1, Math.floor(p.dailyCap)))
      : DEFAULT_OUTREACH_PREFS.dailyCap
  const followUpDays =
    typeof p.followUpDays === 'number' && Number.isFinite(p.followUpDays)
      ? Math.min(60, Math.max(1, Math.floor(p.followUpDays)))
      : DEFAULT_OUTREACH_PREFS.followUpDays
  return {
    autoSend: p.autoSend === true,
    dailyCap,
    followUpDays,
  }
}
