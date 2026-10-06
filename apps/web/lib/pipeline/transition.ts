// The one TypeScript caller of the pipeline's SQL functions. An application's state and its timeline
// are written by pipeline_transition, pipeline_note, pipeline_pause and pipeline_resume and by nothing
// else; transition.test.ts scans the source and fails on any other write. The functions refuse in SQL
// (caps, Pause, the person-only kinds, the send block), so a caller that forgets to ask still cannot
// pass them.
//
// Pass the service-role client: the functions are executable by the service role only.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MoveFrom } from './states'
import type { Actor, ApplicationState, Channel, EventKind, NeedsReason, Origin, PipelineEvent, Prov, RecordEvent, RecordEventInput, Trust } from './types'

/** The line an event adds to the timeline, as the SQL functions read it. */
export interface EventBody {
  kind: EventKind
  actor: Actor
  channel?: Channel
  actorLabel?: string
  sentence: string
  idempotencyKey: string
  payload?: Record<string, unknown>
  step?: string
  trust?: Trust
  origin?: Origin
  prov?: Prov
  proof?: Record<string, unknown>
  traceId?: string
  costUsd?: number
  freeModel?: boolean
  modelCalls?: number
  durationMs?: number
  headerVerdict?: { domain: string | null; dkim: string | null }
  /** When the application is due next (preparing and scheduled). */
  nextAt?: string
  /** Count this move as one more try. */
  attemptInc?: boolean
  closedReason?: string | null
}

export interface MoveInput {
  applicationId: string
  /** The states the move may start from; 'none' is a row with no state. */
  from: MoveFrom[]
  to: ApplicationState
  /** The line shown while it is there. */
  step?: string | null
  /** The one thing it waits on, for a move to needs_you. */
  reason?: NeedsReason | null
  detail?: Record<string, unknown> | null
  event: EventBody
  /** A cap the caller states. The ceilings in SQL hold whatever it says. */
  cap?: { kind: EventKind; actor: Actor; max: number } | null
}

export type Refusal = { ok: false; refusal: string; sentence: string }
export type Moved = { ok: true; replay: boolean; event: PipelineEvent; leaseHolder?: string }
export type MoveResult = Moved | Refusal

/** The SQL's jsonb event body: snake_case, only what is set. */
export function eventJson(e: EventBody): Record<string, unknown> {
  const j: Record<string, unknown> = {
    kind: e.kind,
    actor: e.actor,
    sentence: e.sentence,
    idempotency_key: e.idempotencyKey,
  }
  const set = (k: string, v: unknown) => {
    if (v !== undefined) j[k] = v
  }
  set('channel', e.channel)
  set('actor_label', e.actorLabel)
  set('payload', e.payload)
  set('step', e.step)
  set('trust', e.trust)
  set('origin', e.origin)
  set('prov', e.prov)
  set('proof', e.proof)
  set('trace_id', e.traceId)
  set('cost_usd', e.costUsd)
  set('free_model', e.freeModel)
  set('model_calls', e.modelCalls)
  set('duration_ms', e.durationMs)
  set('header_verdict', e.headerVerdict)
  set('next_at', e.nextAt)
  set('attempt_inc', e.attemptInc)
  set('closed_reason', e.closedReason)
  return j
}

function answer(data: unknown): MoveResult {
  const r = data as { ok?: boolean; replay?: boolean; event?: PipelineEvent; lease_holder?: string; refusal?: string; sentence?: string } | null
  if (r?.ok && r.event) return { ok: true, replay: Boolean(r.replay), event: r.event, leaseHolder: r.lease_holder }
  return { ok: false, refusal: r?.refusal ?? 'error', sentence: r?.sentence ?? 'Could not save that. Try again.' }
}

/** One move of one application. Returns the event, or the refusal and the sentence for the person. */
export async function transition(admin: SupabaseClient, m: MoveInput): Promise<MoveResult> {
  const { data, error } = await admin.rpc('pipeline_transition', {
    p_app: m.applicationId,
    p_from: m.from,
    p_to: m.to,
    p_step: m.step ?? null,
    p_reason: m.reason ?? null,
    p_detail: m.detail ?? null,
    p_event: eventJson(m.event),
    p_cap: m.cap ?? null,
  })
  if (error) throw new Error(`pipeline_transition failed: ${error.message}`)
  return answer(data)
}

/** A line on the timeline that moves no state. A stage the person sets also sets the stage. */
export async function note(admin: SupabaseClient, userId: string, applicationId: string | null, e: EventBody): Promise<MoveResult> {
  const { data, error } = await admin.rpc('pipeline_note', { p_user: userId, p_app: applicationId, p_event: eventJson(e) })
  if (error) throw new Error(`pipeline_note failed: ${error.message}`)
  return answer(data)
}

export async function pause(admin: SupabaseClient, userId: string): Promise<{ ok: boolean; already: boolean }> {
  const { data, error } = await admin.rpc('pipeline_pause', { p_user: userId })
  if (error) throw new Error(`pipeline_pause failed: ${error.message}`)
  const r = data as { ok?: boolean; already?: boolean } | null
  return { ok: Boolean(r?.ok), already: Boolean(r?.already) }
}

export async function resume(admin: SupabaseClient, userId: string): Promise<{ ok: boolean; already: boolean }> {
  const { data, error } = await admin.rpc('pipeline_resume', { p_user: userId })
  if (error) throw new Error(`pipeline_resume failed: ${error.message}`)
  const r = data as { ok?: boolean; already?: boolean } | null
  return { ok: Boolean(r?.ok), already: Boolean(r?.already) }
}

/** Why an application may not be sent without a click, or null. SQL holds the part the database sees. */
export async function autoSendReason(admin: SupabaseClient, applicationId: string): Promise<string | null> {
  const { data, error } = await admin.rpc('pipeline_auto_send_reason', { p_app: applicationId })
  if (error) throw new Error(`pipeline_auto_send_reason failed: ${error.message}`)
  return (data as string | null) ?? null
}

export class PipelineRefused extends Error {
  constructor(
    readonly refusal: string,
    readonly sentence: string,
  ) {
    super(sentence)
    this.name = 'PipelineRefused'
  }
}

/**
 * The function other lanes call to add a line to a timeline (the type is in ./types). It moves
 * nothing, and a person-only kind from any other actor throws PipelineRefused.
 */
export function makeRecordEvent(admin: SupabaseClient): RecordEvent {
  return async (i: RecordEventInput) => {
    const r = await note(admin, i.userId, i.applicationId, {
      kind: i.kind,
      actor: i.actor,
      channel: i.channel,
      actorLabel: i.actorLabel,
      sentence: i.sentence,
      idempotencyKey: i.idempotencyKey,
      payload: i.payload,
      step: i.step,
      trust: i.trust,
      origin: i.origin,
      prov: i.prov,
    })
    if (!r.ok) throw new PipelineRefused(r.refusal, r.sentence)
    return r.event
  }
}
