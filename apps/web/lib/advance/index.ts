// The advancer: takes one application from Preparing toward Ready, one bounded step at a time. The minute
// sweeper posts a due application here (reason advance on /api/agent/continue). Every step is its own
// event under its own key, so a step that already ran is never run again, a step that dies is picked up
// by the sweeper (stale heartbeat, three tries, then Not sent), and an application is never held by two
// callers at once (a lease, taken by one conditional update).
//
// A step either carries on, or moves the application to the one thing it waits on: the person (an
// answer, an approval, "Already applied?") or the clock (a rate limit: a minute, or tomorrow).
//
// The step list is not fixed: a step that learns the form asks for something (answers to draft, a cover letter)
// adds a step after itself, and the addition is its own step.finished event (payload.changed = 'added') whose
// sentence the thread shows: what changed and why. A retry reads those events back, so it walks the same list.

import type { SupabaseClient } from '@supabase/supabase-js'
import { eligibility } from '@/lib/fill/eligibility'
import { DOORS } from '@/lib/pipeline/actors'
import { autoSendReason, note, transition, type EventBody, type MoveResult } from '@/lib/pipeline/transition'
import { rateLimitOf, sumCost, waitAfter, type CostRow } from './cost'
import { ADDED_STEPS, STEPS, defaultFetchForm, startedHandsOff, type AddedStep, type Step, type StepCtx } from './steps'

const LEASE_MS = 5 * 60_000
/** The slice is 240 seconds; start no new step after this. */
const BUDGET_MS = 200_000
const MAX_TRIES = 3

export interface AdvanceOptions {
  now?: () => number
  steps?: readonly Step[]
  fetchForm?: StepCtx['fetchForm']
  tailorResume?: StepCtx['tailorResume']
  writeCoverLetter?: StepCtx['writeCoverLetter']
  draftAnswer?: StepCtx['draftAnswer']
  /** Asked before each step: true when the person has stopped this work. The application is then paused, not carried on by the sweeper. */
  shouldStop?: () => Promise<boolean>
}

/** The plan's steps plus the ones added so far, each after the step that added it. */
export function withAdded(steps: readonly Step[], added: readonly { after: string; step: AddedStep['step'] }[]): Step[] {
  const out = [...steps]
  for (const a of added) {
    const step = ADDED_STEPS[a.step]
    if (!step || out.some((s) => s.id === step.id)) continue
    const at = out.findIndex((s) => s.id === a.after)
    out.splice(at < 0 ? out.length : at + 1, 0, step)
  }
  return out
}

/** One line for the thread: what was added and why. */
export function addedLine(a: AddedStep, count?: number): string {
  const what = a.step === 'cover_letter' ? 'write a cover letter' : `draft ${count ?? ''}${count ? ' ' : ''}${count === 1 ? 'answer' : 'answers'}`
  return `Added a step: ${what}. ${a.why}`
}

interface Row {
  id: string
  user_id: string
  job_id: string
  state: string | null
  attempt: number
  last_event_at: string | null
  posting_url_hash: string | null
  jobs: { url: string; title: string; company_id: string; closed_at: string | null; still_open: boolean | null; companies: { name: string } | null } | null
}

const base = (kind: EventBody['kind'], key: string, sentence: string, extra: Partial<EventBody> = {}): EventBody => ({
  kind,
  actor: DOORS.routine.actor,
  channel: DOORS.routine.channel,
  sentence,
  idempotencyKey: key,
  ...extra,
})

/** Take the application for a few minutes, unless a live holder has it. One conditional update, so two callers cannot both win. */
async function claimLease(admin: SupabaseClient, id: string, now: number): Promise<boolean> {
  const at = new Date(now).toISOString()
  const { data } = await admin
    .from('applications')
    .update({ lease_until: new Date(now + LEASE_MS).toISOString(), lease_holder: crypto.randomUUID(), heartbeat_at: at })
    .eq('id', id)
    .eq('state', 'preparing')
    .or(`lease_until.is.null,lease_until.lt.${at}`)
    .select('id')
  return Boolean(data && data.length > 0)
}

async function release(admin: SupabaseClient, id: string): Promise<void> {
  await admin.from('applications').update({ lease_until: null, lease_holder: null }).eq('id', id).eq('state', 'preparing')
}

interface RecordedAddition {
  after: string
  step: AddedStep['step']
  why: string
}

function readAddition(value: unknown): RecordedAddition | null {
  if (!value || typeof value !== 'object') return null
  const a = value as Record<string, unknown>
  return typeof a.after === 'string' && typeof a.step === 'string' && a.step in ADDED_STEPS
    ? { after: a.after, step: a.step as AddedStep['step'], why: typeof a.why === 'string' ? a.why : '' }
    : null
}

const additionKey = (a: Pick<RecordedAddition, 'after' | 'step'>) => `${a.after}:${a.step}`

/** Write the thread line once. The parent event already carries the addition, so a retry can recover a failed note. */
async function persistAdditionNotes(admin: SupabaseClient, app: Row, attempt: number, additions: readonly RecordedAddition[], recorded: Set<string>, required: boolean): Promise<void> {
  for (const addition of additions) {
    const key = additionKey(addition)
    if (recorded.has(key)) continue
    const count = addition.step === 'draft_answers' ? Number(/\d+/.exec(addition.why)?.[0]) || undefined : undefined
    try {
      const result = await note(admin, app.user_id, app.id, base('step.finished', `step:${app.id}:${addition.after}:${attempt}:added:${addition.step}`, addedLine(addition, count), { step: addition.after, payload: { changed: 'added', ...addition } }))
      if (!result.ok) throw new Error(`could not record added step ${addition.step}`)
      recorded.add(key)
    } catch (error) {
      if (required) throw error
    }
  }
}

/** The cost of what was done for this application, kept on the row. */
export async function recordCost(admin: SupabaseClient, applicationId: string): Promise<void> {
  const { data } = await admin.from('pipeline_events').select('cost_usd, free_model').eq('application_id', applicationId).limit(500)
  const c = sumCost((data ?? []) as CostRow[])
  await admin.from('applications').update({ cost_usd: c.usd }).eq('id', applicationId)
}

export async function advanceOne(admin: SupabaseClient, applicationId: string, opts: AdvanceOptions = {}): Promise<MoveResult | null> {
  const now = opts.now ?? Date.now
  const started = now()
  const { data } = await admin
    .from('applications')
    .select('id, user_id, job_id, state, attempt, last_event_at, posting_url_hash, jobs(url, title, company_id, closed_at, still_open, companies(name))')
    .eq('id', applicationId)
    .maybeSingle()
  const app = data as unknown as Row | null
  if (!app || app.state !== 'preparing' || !app.jobs) return null
  if (!(await claimLease(admin, app.id, started))) return null

  const ctx: StepCtx = {
    admin,
    app: { id: app.id, user_id: app.user_id, job_id: app.job_id, posting_url_hash: app.posting_url_hash },
    job: { url: app.jobs.url, title: app.jobs.title, company_id: app.jobs.company_id, closed_at: app.jobs.closed_at, still_open: app.jobs.still_open, companyName: app.jobs.companies?.name ?? null },
    fetchForm: opts.fetchForm ?? defaultFetchForm,
    tailorResume: opts.tailorResume,
    writeCoverLetter: opts.writeCoverLetter,
    draftAnswer: opts.draftAnswer,
  }
  const key = (step: string) => `step:${app.id}:${step}:${app.attempt}`

  try {
    // A completion or wait event carries its additions atomically. The separate added-step event is only the
    // thread line. If that note failed, recreate it before treating the recovered plan as complete.
    const { data: eventRows } = await admin.from('pipeline_events').select('payload').eq('application_id', app.id).eq('user_id', app.user_id).order('created_at', { ascending: true }).limit(500)
    const recorded = new Set<string>()
    const recovered = new Map<string, RecordedAddition>()
    for (const row of (eventRows as { payload: Record<string, unknown> | null }[] | null) ?? []) {
      const payload = row.payload ?? {}
      if (payload.changed === 'added') {
        const addition = readAddition(payload)
        if (addition) recorded.add(additionKey(addition))
      }
      for (const value of Array.isArray(payload.additions) ? payload.additions : []) {
        const addition = readAddition(value)
        if (addition) recovered.set(additionKey(addition), addition)
      }
    }
    await persistAdditionNotes(admin, app, app.attempt, [...recovered.values()], recorded, true)
    const additions = new Map<string, RecordedAddition>()
    for (const addition of recovered.values()) additions.set(additionKey(addition), addition)
    for (const key of recorded) {
      if (additions.has(key)) continue
      const [after, step] = key.split(':')
      additions.set(key, { after, step: step as AddedStep['step'], why: '' })
    }
    // Not "no": the person can Resume. The steps already done are kept and are not run again.
    const stopped = (at: string) => transition(admin, { applicationId: app.id, from: ['preparing'], to: 'paused', step: 'Stopped by you', event: { ...base('application.paused', `stopped:${app.id}:${at}:${app.last_event_at ?? 'none'}`, 'Stopped from Chat. Resume it when you want Cello to carry on.', { step: at }), actor: DOORS.chat.actor, channel: DOORS.chat.channel } })
    const steps = withAdded(opts.steps ?? STEPS, [...additions.values()])
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const done = `${key(step.id)}:done`
      // a step that finished before is not run again: its event is its saved result
      const { data: had } = await admin.from('pipeline_events').select('id').eq('user_id', app.user_id).eq('idempotency_key', done).maybeSingle()
      if (had) continue
      if (await opts.shouldStop?.()) return stopped(step.id)
      if (now() - started > BUDGET_MS) {
        await release(admin, app.id)
        return null
      }
      await admin.from('applications').update({ heartbeat_at: new Date(now()).toISOString() }).eq('id', app.id)
      const t0 = now()
      const out = await step.run(ctx)
      const ms = now() - t0

      if (out.kind === 'wait') {
        const added = (out.add ?? []).map((addition) => ({ ...addition, after: step.id }))
        const payload = { ...(out.detail ?? {}), ...(added.length ? { additions: added } : {}) }
        const r = await transition(admin, { applicationId: app.id, from: ['preparing'], to: 'needs_you', reason: out.reason, detail: out.detail ?? null, step: step.doing, event: base(out.reason === 'approve_resume' ? 'approval.requested' : out.reason === 'duplicate' ? 'application.duplicate' : 'question.asked', `${key(step.id)}:wait:${app.last_event_at ?? 'none'}`, out.line, { step: step.id, durationMs: ms, payload }) })
        // The transition atomically persisted the additions before waiting. The retry recreates a missing thread line.
        if (r.ok) await persistAdditionNotes(admin, app, app.attempt, added, recorded, false)
        await recordCost(admin, app.id)
        return r
      }
      if (out.kind === 'close') {
        const r = await transition(admin, { applicationId: app.id, from: ['preparing'], to: 'skipped', step: step.doing, event: base('application.skipped', done, out.line, { step: step.id, durationMs: ms, closedReason: out.closedReason }) })
        return r
      }
      const added = (out.add ?? []).map((addition) => ({ ...addition, after: step.id }))
      const payload = { ...(out.payload ?? {}), ...(added.length ? { additions: added } : {}) }
      const completed = await transition(admin, { applicationId: app.id, from: ['preparing'], to: 'preparing', step: step.doing, event: base('step.finished', done, out.line, { step: step.id, durationMs: ms, payload }) })
      if (!completed.ok) return completed
      // The completion and its additions are one event. A failed status note makes this attempt retry; the next
      // attempt reads the parent payload, writes one missing line and inserts the added step once.
      await persistAdditionNotes(admin, app, app.attempt, added, recorded, true)
      for (const addition of added) {
        if (steps.some((candidate) => candidate.id === addition.step)) continue
        steps.splice(i + 1, 0, ADDED_STEPS[addition.step])
      }
    }
    if (await opts.shouldStop?.()) return stopped('ready')
    const r = await transition(admin, { applicationId: app.id, from: ['preparing'], to: 'ready', step: 'Ready to send', event: base('step.finished', `ready:${app.id}:${app.attempt}`, 'Everything is prepared. It is ready for you to send.', { step: 'ready' }) })
    // Started in Hands-off: one more line says whether Send for me may take it, in SQL's words (its switch, caps and
    // rules) or code's (the site is not one Cello sends on yet). A line that moves nothing; the person reads why it waits.
    if (r.ok && (await startedHandsOff(admin, app))) {
      const why = (await autoSendReason(admin, app.id)) ?? eligibility({ company: ctx.job.companyName ?? 'The employer', url: ctx.job.url, fields: [] })
      await note(admin, app.user_id, app.id, base('step.finished', `ready-mode:${app.id}:${app.attempt}`, why ? `It waits for you: ${why}` : 'Send for me will send it from your browser.', { step: 'ready' }))
    }
    await recordCost(admin, app.id)
    return r
  } catch (e) {
    return await failed(admin, app, e, now)
  } finally {
    await release(admin, app.id)
  }
}

/** A step threw. A rate limit waits; anything else is one more try, and the third is Not sent. */
async function failed(admin: SupabaseClient, app: Row, err: unknown, now: () => number): Promise<MoveResult> {
  const limit = rateLimitOf(err)
  if (limit) {
    const w = waitAfter(limit, new Date(now()))
    return transition(admin, { applicationId: app.id, from: ['preparing'], to: 'scheduled', step: w.sentence, event: base('limit.reached', `limit:${app.id}:${app.attempt}:${limit}`, w.sentence, { nextAt: w.nextAt, attemptInc: false, payload: { limit } }) })
  }
  const last = app.attempt + 1 >= MAX_TRIES
  const sentence = last ? 'A step stopped three times. Cello could not finish preparing this.' : 'A step stopped before it finished. Cello will try again.'
  return transition(admin, {
    applicationId: app.id,
    from: ['preparing'],
    to: last ? 'not_sent' : 'preparing',
    step: last ? 'Cello could not finish preparing this.' : 'Trying again',
    event: base('step.failed', `failed:${app.id}:${app.attempt}`, sentence, { attemptInc: true, payload: { cause: err instanceof Error ? err.name : 'error' } }),
  })
}
