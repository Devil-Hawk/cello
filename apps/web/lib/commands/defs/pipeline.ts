// applications.start: Chat starts an application for a role the person named. It prepares it (checks the posting,
// the earlier applications, the base resume, a tailored resume that waits for the person's approval) and stops
// there. It never fills a form, approves, sends or marks anything sent: those are the person's clicks. The turn's
// mode (set by code at the door, never an input) is recorded on the created event: in Hands-off the advancer may
// use the tailored resume without a stop and Send for me may claim the application, within its own limits.
// Several roles in one call fan out, one row each with its own Stop. A call the Chat loop replays after a restart
// finds its application already created in this turn and returns the stored state: nothing is attached or advanced twice.

import { z } from 'zod'
import { advanceOne } from '@/lib/advance'
import { SLICE_MS } from '@/lib/agents/context'
import { fanOut } from '@/lib/agents/fanout'
import { attach, ledgerKey } from '@/lib/chat/attach'
import { runWorkers, withWorker, type WorkerBranch } from '@/lib/chat/workers'
import { DOORS } from '@/lib/pipeline/actors'
import { start } from '@/lib/pipeline/commands'
import { CommandRefusal, defineCommand, type AnyCommand, type CommandContext } from '../define'
import { codeText } from '../text'

/** Applications Chat may start in one turn. */
export const STARTS_PER_TURN = 3

const NOT_FOUND = 'That role is not in your stored roles.'
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const noStop = { checkStop: async () => undefined } as Pick<WorkerBranch, 'checkStop'>

const idsOf = (input: { job_id?: string; job_ids?: string[] }): string[] => [...new Set(input.job_ids ?? (input.job_id ? [input.job_id] : []))]

/** An application.created event of this person's, written by this Chat turn: the call is being replayed. */
async function createdThisTurn(db: ReturnType<CommandContext['admin']>, userId: string, applicationId: string, turnId?: string): Promise<boolean> {
  if (!turnId) return false
  const { data } = await db.from('pipeline_events').select('payload').eq('user_id', userId).eq('application_id', applicationId).eq('kind', 'application.created')
  return ((data as { payload: { turn_id?: string } | null }[] | null) ?? []).some((e) => e.payload?.turn_id === turnId)
}

export const applicationsStart = defineCommand({
  id: 'applications.start',
  label: 'Start an application',
  input: z
    .strictObject({ job_id: z.string().max(100), job_ids: z.array(z.string().max(100)).min(1).max(STARTS_PER_TURN) })
    .partial()
    .refine((v) => (v.job_id === undefined) !== (v.job_ids === undefined), 'Give job_id or job_ids, not both.'),
  output: z.object({
    sentence: codeText(300),
    application_id: codeText(100),
    state: codeText(30),
    steps: z.array(codeText(280)).max(20),
    applications: z.array(z.object({ job_id: codeText(100), application_id: codeText(100), state: codeText(30) })).max(STARTS_PER_TURN),
  }),
  callers: ['chat'],
  kind: 'code',
  sends: false,
  egress: 'record',
  limits: { bucket: 'starts' },
  measure: 'P6',
  async guard(ctx, input) {
    if (!ctx.chat) return null
    const ids = idsOf(input)
    const { data } = await ctx.admin().from('agent_tasks').select('object').eq('user_id', ctx.userId).eq('turn_id', ctx.chat.turnId).eq('command', 'applications.start')
    // A replay asks for the same roles again, so their rows do not count twice.
    const others = new Set(((data as { object: { ref?: string } | null }[] | null) ?? []).flatMap((r) => (r.object?.ref && !ids.includes(r.object.ref) ? [r.object.ref] : [])))
    return others.size + ids.length > STARTS_PER_TURN ? `Cello starts at most ${STARTS_PER_TURN} applications in one message.` : null
  },
  async run(ctx, input) {
    const db = ctx.admin()
    const ids = idsOf(input)
    const { data: found } = await db.from('person_jobs').select('id, title').eq('viewer_id', ctx.userId).in('id', ids)
    const titles = new Map(((found as { id: string; title: string }[] | null) ?? []).map((j) => [j.id, j.title]))
    const jobs = ids.flatMap((id) => (titles.has(id) ? [{ id, title: titles.get(id) as string }] : []))
    if (jobs.length === 0) throw new CommandRefusal(404, NOT_FOUND, 'not_found')
    const mode = ctx.mode ?? 'ask'
    const tail = mode === 'hands_off' ? 'Send for me sends it from your browser when it is ready, within its limits.' : 'Nothing was sent.'

    const startOne = async (job: { id: string; title: string }, branch: Pick<WorkerBranch, 'checkStop'>) => {
      await branch.checkStop()
      const moved = await start({ admin: db, userId: ctx.userId, door: DOORS.chat }, job.id, {
        payload: { mode, ...(ctx.chat ? { turn_id: ctx.chat.turnId } : {}), ...(ctx.callKey ? { call_key: ctx.callKey } : {}) },
      })
      if (!moved.ok && moved.refusal !== 'already') throw new CommandRefusal(409, moved.sentence, moved.refusal)
      const { data: app } = await db.from('applications').select('id').eq('user_id', ctx.userId).eq('job_id', job.id).maybeSingle()
      const applicationId = (app as { id: string } | null)?.id
      if (!applicationId) throw new CommandRefusal(404, 'That application is gone.', 'not_found')
      if (!moved.ok) {
        // Already started: a replay of this turn's own call returns what it made; anything else is refused.
        if (!(await createdThisTurn(db, ctx.userId, applicationId, ctx.chat?.turnId))) throw new CommandRefusal(409, moved.sentence, moved.refusal)
      } else {
        // The chat holds the application from now on, so each step reaches it as a status turn.
        if (ctx.chat) await attach(db, ctx.userId, ctx.chat.chatId, { kind: 'application', ref: { id: applicationId } }, { origin: 'model', turnId: ctx.chat.turnId, returned: new Set([ledgerKey('application', applicationId)]) })
        await branch.checkStop()
        await advanceOne(db, applicationId)
      }
      const { data: after } = await db.from('applications').select('state').eq('id', applicationId).maybeSingle()
      const state = (after as { state: string | null } | null)?.state ?? 'preparing'
      const { data: events } = await db.from('pipeline_events').select('sentence').eq('application_id', applicationId).eq('user_id', ctx.userId).order('created_at', { ascending: true }).limit(20)
      const steps = ((events as { sentence: string | null }[] | null) ?? []).flatMap((e) => (e.sentence ? [e.sentence.slice(0, 280)] : []))
      return { job_id: job.id, application_id: applicationId, state, steps }
    }

    const scope = ctx.chat && { db, userId: ctx.userId, threadId: ctx.chat.chatId, chatId: ctx.chat.chatId, turnId: ctx.chat.turnId }
    if (ids.length === 1) {
      const job = jobs[0]
      const one = await (scope ? withWorker(scope, { command: 'applications.start', title: `Preparing ${job.title}`, object: { kind: 'role', ref: job.id } }, () => startOne(job, noStop)) : startOne(job, noStop))
      return { sentence: `Started ${job.title}. It is now ${one.state.replace('_', ' ')}. ${tail}`, application_id: one.application_id, state: one.state, steps: one.steps, applications: [{ job_id: one.job_id, application_id: one.application_id, state: one.state }] }
    }

    // Several roles: one row each, four at a time at most, each with its own Stop. The cap is the whole slice so a start is never cut short.
    const caps = { steps: 20, ms: SLICE_MS, tokens: 0 }
    const deadlineAt = Date.now() + SLICE_MS
    const results = scope
      ? await runWorkers(scope, { command: 'applications.start', items: jobs, titleOf: (j) => `Preparing ${j.title}`, objectOf: (j) => ({ kind: 'role', ref: j.id }), caps, deadlineAt, signal: ctx.signal, worker: startOne })
      : await fanOut({ items: jobs, caps, deadlineAt, signal: ctx.signal, worker: (j) => startOne(j, noStop) })
    const reasons = [
      ...ids.filter((id) => !titles.has(id)).map(() => NOT_FOUND),
      ...results.results.flatMap((r) => (r.status === 'ok' && r.value ? [] : [r.error ?? 'It ran out of time before it started.'])),
    ]
    const done = results.results.flatMap((r) => (r.status === 'ok' && r.value ? [{ ...r.value, title: jobs[r.index].title }] : []))
    if (done.length === 0) throw new CommandRefusal(409, reasons[0], 'failed')
    const sentence = [
      `Started ${done.length} of ${ids.length}: ${done.map((d) => clip(d.title, 40)).join(', ')}.`,
      reasons.length > 0 && `${reasons.length} could not start: ${clip(reasons[0].replace(/\.$/, ''), 60)}.`,
      tail,
    ]
      .filter(Boolean)
      .join(' ')
    return {
      sentence: sentence.slice(0, 300),
      application_id: done[0].application_id,
      state: done[0].state,
      steps: done[0].steps,
      applications: done.map((d) => ({ job_id: d.job_id, application_id: d.application_id, state: d.state })),
    }
  },
})

export const pipelineCommands: AnyCommand[] = [applicationsStart]
