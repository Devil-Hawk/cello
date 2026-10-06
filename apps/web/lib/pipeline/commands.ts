// The commands that move an application, as plain functions. The caller's code path decides the door
// (a session route is the person, the clock is Cello, a rule is the person's rule); a model never
// picks it. Every move goes through transition.ts, so the refusals that matter (caps, Pause, the
// person-only kinds, the send block) are SQL's and hold whatever this file forgets.
//
// ponytail: plain functions, called by session routes. K10's defineCommand wraps them once it is on main.

import type { SupabaseClient } from '@supabase/supabase-js'
import { actorWords, type Door } from './actors'
import { canMove, type MoveFrom } from './states'
import { readPipelineSettings } from './settings'
import { note, pause, resume, transition, type MoveResult } from './transition'
import type { ApplicationState, ClosedReason, EventKind, Stage } from './types'

export interface Ctx {
  admin: SupabaseClient
  userId: string
  door: Door
}

interface AppRow {
  id: string
  job_id: string
  state: ApplicationState | null
  state_before_pause: ApplicationState | null
  needs_reason: string | null
  stage: string
  last_event_at: string | null
}

const refuse = (refusal: string, sentence: string): MoveResult => ({ ok: false, refusal, sentence })

async function load(c: Ctx, id: string): Promise<AppRow | null> {
  const { data } = await c.admin
    .from('applications')
    .select('id, job_id, state, state_before_pause, needs_reason, stage, last_event_at')
    .eq('id', id)
    .eq('user_id', c.userId)
    .maybeSingle()
  return (data as AppRow | null) ?? null
}

/** One key per (action, application, last move): a double click replays, the next move is new. */
const keyOf = (action: string, a: AppRow) => `${action}:${a.id}:${a.last_event_at ?? 'none'}`

const body = (c: Ctx, kind: EventKind, a: AppRow, sentence: string, extra: { payload?: Record<string, unknown>; step?: string } = {}) => ({
  kind,
  actor: c.door.actor,
  channel: c.door.channel,
  actorLabel: actorWords(c.door.actor, c.door.channel),
  sentence,
  idempotencyKey: keyOf(kind, a),
  ...extra,
})

const from = (a: AppRow): MoveFrom => a.state ?? 'none'

/** A move whose start the table must allow; an illegal one is refused here with the same words SQL uses. */
async function move(
  c: Ctx,
  id: string,
  to: ApplicationState,
  kind: EventKind,
  sentence: string,
  opts: { from?: MoveFrom[]; step?: string | null; reason?: 'duplicate' | null; detail?: Record<string, unknown>; payload?: Record<string, unknown>; closedReason?: ClosedReason | null } = {},
): Promise<MoveResult> {
  const a = await load(c, id)
  if (!a) return refuse('missing', 'That application is gone.')
  const start = opts.from ?? [from(a)]
  if (!start.some((s) => canMove(s, to))) return refuse('stale', 'This changed while you were looking. Open it again.')
  return transition(c.admin, {
    applicationId: a.id,
    from: start,
    to,
    step: opts.step ?? null,
    reason: opts.reason ?? null,
    detail: opts.detail ?? null,
    event: { ...body(c, kind, a, sentence, { payload: opts.payload }), closedReason: opts.closedReason },
  })
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/** Apply: Cello prepares this role. A role already sent becomes "Already applied?" for the person and is refused for everyone else. */
export async function start(c: Ctx, jobId: string): Promise<MoveResult> {
  let { data: row } = await c.admin.from('applications').select('id').eq('user_id', c.userId).eq('job_id', jobId).maybeSingle()
  if (!row) {
    const ins = await c.admin.from('applications').insert({ user_id: c.userId, job_id: jobId, source: c.door.actor }).select('id').single()
    if (ins.error) {
      // two Apply clicks at once: the other one made the row
      const again = await c.admin.from('applications').select('id').eq('user_id', c.userId).eq('job_id', jobId).maybeSingle()
      row = again.data
    } else row = ins.data
  }
  // no row and none made: the role is gone (the foreign key refused it)
  if (!row) return refuse('missing', 'That role is gone.')
  const a = await load(c, (row as { id: string }).id)
  if (!a) return refuse('missing', 'That application is gone.')
  if (a.state && !['skipped', 'not_sent'].includes(a.state)) return refuse('already', 'Cello is already working on this one.')

  const settings = readPipelineSettings((await c.admin.from('profiles').select('preferences').eq('id', c.userId).maybeSingle()).data?.preferences)
  const cap = c.door.actor === 'rule' ? { kind: 'application.created' as const, actor: 'rule' as const, max: settings.want.maxPerDay } : null
  const r = await transition(c.admin, {
    applicationId: a.id,
    from: [from(a)],
    to: 'preparing',
    step: 'Starting',
    event: body(c, 'application.created', a, 'Cello started preparing this.'),
    cap,
  })
  if (!r.ok && r.refusal === 'send_block' && c.door.actor === 'person') {
    return transition(c.admin, {
      applicationId: a.id,
      from: [from(a)],
      to: 'needs_you',
      reason: 'duplicate',
      event: body(c, 'application.duplicate', a, 'You may have applied to this already.'),
    })
  }
  return r
}

// ---------------------------------------------------------------------------
// Moves the person or Cello makes on an application
// ---------------------------------------------------------------------------

export const skip = (c: Ctx, id: string) =>
  move(c, id, 'skipped', 'application.skipped', 'Skipped.', { from: ['none', 'preparing', 'needs_you', 'scheduled', 'ready', 'not_sent'], closedReason: 'skipped' })

/** Pause one application. Resume puts it back where it was. */
export const pauseOne = (c: Ctx, id: string) => move(c, id, 'paused', 'application.paused', 'Paused.', { from: ['preparing', 'scheduled', 'ready', 'needs_you'] })

export async function resumeOne(c: Ctx, id: string): Promise<MoveResult> {
  const a = await load(c, id)
  if (!a) return refuse('missing', 'That application is gone.')
  if (a.state !== 'paused' || !a.state_before_pause) return refuse('stale', 'This changed while you were looking. Open it again.')
  return move(c, id, a.state_before_pause, 'application.resumed', 'Resumed.', { from: ['paused'] })
}

/** Run again, from Not sent only. */
export const runAgain = (c: Ctx, id: string) => move(c, id, 'preparing', 'step.started', 'Cello started this again.', { from: ['not_sent'], step: 'Starting again' })

/** Approve the tailored resume (person only, in SQL). The hash of the version the person saw is kept on the event; ponytail: nothing compares it with the current version until K17's artifacts serve the document, then a stale hash is refused. */
export async function approveDocument(c: Ctx, id: string, hash: string): Promise<MoveResult> {
  return move(c, id, 'preparing', 'approval.decided', 'You approved the resume.', { from: ['needs_you'], step: 'Continuing', payload: { decision: 'approved', hash } })
}

/** "Already applied?" answered with Apply anyway; releases the posting for this start. */
export const applyAnyway = (c: Ctx, id: string) =>
  move(c, id, 'preparing', 'application.duplicate_override', 'You chose to apply anyway.', { from: ['needs_you'], step: 'Starting' })

export const markSent = (c: Ctx, id: string) =>
  move(c, id, 'sent', 'submission.marked', 'You marked this as sent.', { from: ['none', 'preparing', 'needs_you', 'ready'] })

/** "I did not actually send this": back to Ready, and the posting is released. */
export const retract = (c: Ctx, id: string) => move(c, id, 'ready', 'submission.retracted', 'You said this was not sent.', { from: ['sent'] })

/** "I did not apply" and the No of "Did you send it?": the application goes back to Ready, or is skipped when it was never ready. */
export async function notApplied(c: Ctx, id: string): Promise<MoveResult> {
  const a = await load(c, id)
  if (!a) return refuse('missing', 'That application is gone.')
  if (a.state === 'needs_you' && a.needs_reason === 'check_sent') {
    return move(c, id, 'ready', 'approval.decided', 'You said this was not sent.', { from: ['needs_you'], payload: { decision: 'not_sent' } })
  }
  return skip(c, id)
}

// ---------------------------------------------------------------------------
// Lines that move nothing
// ---------------------------------------------------------------------------

/** Let Cello send one it started from chat: person only. */
export async function allowSend(c: Ctx, id: string): Promise<MoveResult> {
  const a = await load(c, id)
  if (!a) return refuse('missing', 'That application is gone.')
  return note(c.admin, c.userId, a.id, body(c, 'application.send_allowed', a, 'You let Cello send this one.'))
}

/** The person's stage. A stage is a label; the person owns it (person only, in SQL). */
export async function setStage(c: Ctx, id: string, stage: Stage): Promise<MoveResult> {
  const a = await load(c, id)
  if (!a) return refuse('missing', 'That application is gone.')
  return note(c.admin, c.userId, a.id, body(c, 'stage.changed', a, `You set the stage to ${stage}.`, { payload: { stage } }))
}

const CLOSE_STAGE: Partial<Record<ClosedReason, Stage>> = { rejected: 'rejected', withdrew: 'withdrawn', no_reply: 'ghosted' }

/** Close an application: the stage when it says why, else skipped. */
export async function close(c: Ctx, id: string, reason: ClosedReason): Promise<MoveResult> {
  const stage = CLOSE_STAGE[reason]
  return stage ? setStage(c, id, stage) : move(c, id, 'skipped', 'application.skipped', 'Closed: the posting is gone.', { from: ['none', 'preparing', 'needs_you', 'scheduled', 'ready', 'not_sent'], closedReason: reason })
}

// ---------------------------------------------------------------------------
// Pause everything
// ---------------------------------------------------------------------------

export const pauseCello = (c: Ctx) => pause(c.admin, c.userId)
export const resumeCello = (c: Ctx) => resume(c.admin, c.userId)
