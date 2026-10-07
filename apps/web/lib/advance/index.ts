// The advancer: takes one application from Preparing toward Ready, one bounded step at a time. The minute
// sweeper posts a due application here (reason advance on /api/agent/continue). Every step is its own
// event under its own key, so a step that already ran is never run again, a step that dies is picked up
// by the sweeper (stale heartbeat, three tries, then Not sent), and an application is never held by two
// callers at once (a lease, taken by one conditional update).
//
// A step either carries on, or moves the application to the one thing it waits on: the person (an
// answer, an approval, "Already applied?") or the clock (a rate limit: a minute, or tomorrow).

import type { SupabaseClient } from '@supabase/supabase-js'
import { DOORS } from '@/lib/pipeline/actors'
import { transition, type EventBody, type MoveResult } from '@/lib/pipeline/transition'
import { rateLimitOf, sumCost, waitAfter, type CostRow } from './cost'
import { STEPS, defaultFetchForm, type Step, type StepCtx } from './steps'

const LEASE_MS = 5 * 60_000
/** The slice is 240 seconds; start no new step after this. */
const BUDGET_MS = 200_000
const MAX_TRIES = 3

export interface AdvanceOptions {
  now?: () => number
  steps?: readonly Step[]
  fetchForm?: StepCtx['fetchForm']
  tailorResume?: StepCtx['tailorResume']
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
  }
  const key = (step: string) => `step:${app.id}:${step}:${app.attempt}`

  try {
    for (const step of opts.steps ?? STEPS) {
      const done = `${key(step.id)}:done`
      // a step that finished before is not run again: its event is its saved result
      const { data: had } = await admin.from('pipeline_events').select('id').eq('user_id', app.user_id).eq('idempotency_key', done).maybeSingle()
      if (had) continue
      if (now() - started > BUDGET_MS) {
        await release(admin, app.id)
        return null
      }
      await admin.from('applications').update({ heartbeat_at: new Date(now()).toISOString() }).eq('id', app.id)
      const t0 = now()
      const out = await step.run(ctx)
      const ms = now() - t0

      if (out.kind === 'wait') {
        const r = await transition(admin, { applicationId: app.id, from: ['preparing'], to: 'needs_you', reason: out.reason, detail: out.detail ?? null, step: step.doing, event: base(out.reason === 'approve_resume' ? 'approval.requested' : out.reason === 'duplicate' ? 'application.duplicate' : 'question.asked', `${key(step.id)}:wait:${app.last_event_at ?? 'none'}`, out.line, { step: step.id, durationMs: ms, payload: out.detail }) })
        await recordCost(admin, app.id)
        return r
      }
      if (out.kind === 'close') {
        const r = await transition(admin, { applicationId: app.id, from: ['preparing'], to: 'skipped', step: step.doing, event: base('application.skipped', done, out.line, { step: step.id, durationMs: ms, closedReason: out.closedReason }) })
        return r
      }
      await transition(admin, { applicationId: app.id, from: ['preparing'], to: 'preparing', step: step.doing, event: base('step.finished', done, out.line, { step: step.id, durationMs: ms, payload: out.payload }) })
    }
    const r = await transition(admin, { applicationId: app.id, from: ['preparing'], to: 'ready', step: 'Ready to send', event: base('step.finished', `ready:${app.id}:${app.attempt}`, 'Everything is prepared. It is ready for you to send.', { step: 'ready' }) })
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
