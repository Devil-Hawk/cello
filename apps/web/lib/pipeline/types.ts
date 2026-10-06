// The shapes of the pipeline: an application's state, the events that record every move, and the one
// function other lanes call to add a line to the timeline. Types and plain constants only; the SQL
// functions in supabase/migrations/20261013000002_pipeline_functions.sql do the moving, and
// lib/pipeline/transition.ts is the only code that calls them.
//
// The SQL check constraints and the lists below are the same lists. types.test.ts reads the
// migration and fails when they differ.

/** Where Cello stands with one application. Null on a row Cello is not working on (saved, added by hand, imported, found in mail). */
export const APPLICATION_STATES = [
  'preparing',
  'needs_you',
  'scheduled',
  'ready',
  'applying',
  'sent',
  'confirmed',
  'not_sent',
  'skipped',
  'paused',
] as const
export type ApplicationState = (typeof APPLICATION_STATES)[number]

/** The one reason an application waits on the person. One value at a time, by construction. */
export const NEEDS_REASONS = [
  'approve_resume',
  'answer',
  'duplicate',
  'your_turn',
  'check_sent',
  'reconnect',
  'budget',
  'wait_computer',
] as const
export type NeedsReason = (typeof NEEDS_REASONS)[number]

/** Why Send for me or a fill stopped and handed the page to the person (`needs_detail.cause`). */
export const STOP_CAUSES = [
  'sign_in',
  'account',
  'site_check',
  'unreadable',
  'unknown_field',
  'prefilled',
  'wrong_page',
  'upload',
  'form_changed',
  'no_submit',
  'form_error',
  'interrupted',
] as const
export type StopCause = (typeof STOP_CAUSES)[number]

/** The person's stage. Labels only; the person owns it. */
export const STAGES = [
  'discovered',
  'applied',
  'screen',
  'interview',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
  'ghosted',
] as const
export type Stage = (typeof STAGES)[number]

export const CLOSED_REASONS = ['rejected', 'withdrew', 'no_reply', 'posting_closed', 'skipped'] as const
export type ClosedReason = (typeof CLOSED_REASONS)[number]

/** Every kind a timeline line can have. */
export const EVENT_KINDS = [
  'application.created',
  'application.skipped',
  'application.paused',
  'application.resumed',
  'application.duplicate',
  'application.duplicate_override',
  'application.send_allowed',
  'step.started',
  'step.finished',
  'step.failed',
  'question.asked',
  'question.answered',
  'approval.requested',
  'approval.decided',
  'fill.started',
  'fill.auto_started',
  'fill.reported',
  'fill.blocked',
  'submission.sending',
  'submission.sent',
  'submission.unconfirmed',
  'submission.confirmed',
  'submission.marked',
  'submission.retracted',
  'autonomy.changed',
  'stage.suggested',
  'stage.changed',
  'message.received',
  'draft.ready',
  'message.sent',
  'follow_up.due',
  'task.finished',
  'task.missed',
  'find.finished',
  'spend.threshold',
  'limit.reached',
  'connection.lost',
  'pipeline.paused',
  'pipeline.resumed',
  'summary.built',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** Kinds only the person can write. SQL refuses them for every other actor. */
export const PERSON_ONLY_KINDS: readonly EventKind[] = [
  'submission.marked',
  'submission.retracted',
  'approval.decided',
  'application.duplicate_override',
  'application.send_allowed',
  'autonomy.changed',
  'stage.changed',
  'question.answered',
]

/** Kinds only the extension can write, and only for an automatic send. */
export const EXTENSION_ONLY_KINDS: readonly EventKind[] = ['fill.auto_started', 'submission.sending']

/** Kinds that move a count. An unconfirmed one is refused in SQL (measure T10). */
export const COUNT_KINDS: readonly EventKind[] = [
  'stage.changed',
  'submission.sent',
  'submission.marked',
  'submission.confirmed',
]

export const ACTORS = ['person', 'schedule', 'rule', 'cello', 'extension', 'email', 'owner'] as const
export type Actor = (typeof ACTORS)[number]

/** The door an actor came through. `session` with `person`; `chat`, `assistant` and `agent` with `cello`. */
export const CHANNELS = ['session', 'chat', 'assistant', 'agent', 'routine', 'extension', 'inbox'] as const
export type Channel = (typeof CHANNELS)[number]

/** `person` made it, `proven` a code pattern on a message from the verified sender, `confirmed` the person accepted a model's sort, `unconfirmed` everything else. */
export const TRUST_LEVELS = ['person', 'proven', 'confirmed', 'unconfirmed'] as const
export type Trust = (typeof TRUST_LEVELS)[number]

export type Origin = 'person' | 'code' | 'model'

/** `prov` as 3.2 shapes it: {step, model, rung, evidence, at} for a model, {rule} for code, {door} for the person. */
export type Prov = Record<string, unknown>

/** The pipeline columns of public.applications. */
export interface ApplicationPipeline {
  state: ApplicationState | null
  step: string | null
  needs_reason: NeedsReason | null
  needs_detail: Record<string, unknown> | null
  form_fields: unknown[] | null
  auto_attempted_at: string | null
  state_before_pause: ApplicationState | null
  next_at: string | null
  heartbeat_at: string | null
  lease_until: string | null
  lease_holder: string | null
  attempt: number
  dedupe_key: string | null
  posting_url_hash: string | null
  cost_usd: number
  resume_artifact_id: string | null
  last_event_at: string | null
  interview_at: string | null
  closed_reason: ClosedReason | null
  instruction: string | null
  found_state: 'to_confirm' | 'confirmed' | null
}

/** One row of public.pipeline_events. */
export interface PipelineEvent {
  id: string
  user_id: string
  application_id: string | null
  job_id: string | null
  posting_url_hash: string | null
  company_name: string | null
  kind: EventKind
  actor: Actor
  channel: Channel | null
  actor_label: string | null
  /** A declared step or workflow id. */
  step: string | null
  sentence: string
  from_state: ApplicationState | null
  to_state: ApplicationState | null
  payload: Record<string, unknown>
  proof: Record<string, unknown> | null
  trace_id: string | null
  cost_usd: number | null
  free_model: boolean | null
  model_calls: number | null
  duration_ms: number | null
  trust: Trust
  origin: Origin
  prov: Prov | null
  /** DKIM domain and result, for mail events. */
  header_verdict: { domain: string | null; dkim: string | null } | null
  idempotency_key: string
  created_at: string
}

/** What a caller says when it adds a line to a timeline without moving an application. */
export interface RecordEventInput {
  userId: string
  applicationId: string | null
  kind: EventKind
  actor: Actor
  channel?: Channel
  actorLabel?: string
  /** A sentence for the person: plain, no internal names, at most 280 characters. */
  sentence: string
  payload?: Record<string, unknown>
  step?: string
  trust?: Trust
  origin?: Origin
  prov?: Prov
  /** The same key returns the first event instead of writing a second. At most 200 characters. */
  idempotencyKey: string
}

/**
 * Add a line to an application's timeline. It moves nothing: a state change goes through
 * `pipeline_transition`. Person-only kinds are refused for any actor but the person.
 * lib/pipeline/transition.ts implements it over `pipeline_note`.
 */
export type RecordEvent = (input: RecordEventInput) => Promise<PipelineEvent>

/** The five groups of the Applications page (4.8, `groupOf`). */
export const APPLICATION_GROUPS = ['needs_you', 'preparing', 'waiting', 'interview', 'closed'] as const
export type ApplicationGroup = (typeof APPLICATION_GROUPS)[number]
