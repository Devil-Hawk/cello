// applications.start: Chat starts an application for a role the person named. It prepares it (checks the posting,
// the earlier applications, the base resume, a tailored resume that waits for the person's approval) and stops
// there. It never fills a form, approves, sends or marks anything sent: those are the person's clicks.

import { z } from 'zod'
import { advanceOne } from '@/lib/advance'
import { attach, ledgerKey } from '@/lib/chat/attach'
import { withWorker } from '@/lib/chat/workers'
import { DOORS } from '@/lib/pipeline/actors'
import { start } from '@/lib/pipeline/commands'
import { CommandRefusal, defineCommand, type AnyCommand } from '../define'
import { codeText } from '../text'

/** Applications Chat may start in one turn. */
export const STARTS_PER_TURN = 3

export const applicationsStart = defineCommand({
  id: 'applications.start',
  label: 'Start an application',
  input: z.strictObject({ job_id: z.string().max(100) }),
  output: z.object({ sentence: codeText(300), application_id: codeText(100), state: codeText(30), steps: z.array(codeText(280)).max(20) }),
  callers: ['chat'],
  kind: 'code',
  sends: false,
  egress: 'record',
  limits: { bucket: 'starts' },
  measure: 'P6',
  async guard(ctx) {
    if (!ctx.chat) return null
    const { count } = await ctx.admin().from('agent_tasks').select('id', { count: 'exact', head: true }).eq('user_id', ctx.userId).eq('turn_id', ctx.chat.turnId).eq('command', 'applications.start')
    return (count ?? 0) >= STARTS_PER_TURN ? `Cello starts at most ${STARTS_PER_TURN} applications in one message.` : null
  },
  async run(ctx, input) {
    const db = ctx.admin()
    const { data: job } = await db.from('person_jobs').select('id, title').eq('viewer_id', ctx.userId).eq('id', input.job_id).maybeSingle()
    if (!job) throw new CommandRefusal(404, 'That role is not in your stored roles.', 'not_found')
    const scope = ctx.chat && { db, userId: ctx.userId, threadId: ctx.chat.chatId, chatId: ctx.chat.chatId, turnId: ctx.chat.turnId }
    const work = async () => {
      const moved = await start({ admin: db, userId: ctx.userId, door: DOORS.chat }, input.job_id)
      if (!moved.ok) throw new CommandRefusal(409, moved.sentence, moved.refusal)
      const { data: app } = await db.from('applications').select('id').eq('user_id', ctx.userId).eq('job_id', input.job_id).maybeSingle()
      const applicationId = (app as { id: string } | null)?.id
      if (!applicationId) throw new CommandRefusal(404, 'That application is gone.', 'not_found')
      // The chat holds the application from now on, so each step reaches it as a status turn.
      if (ctx.chat) await attach(db, ctx.userId, ctx.chat.chatId, { kind: 'application', ref: { id: applicationId } }, { origin: 'model', turnId: ctx.chat.turnId, returned: new Set([ledgerKey('application', applicationId)]) })
      await advanceOne(db, applicationId)
      const { data: after } = await db.from('applications').select('state').eq('id', applicationId).maybeSingle()
      const state = (after as { state: string | null } | null)?.state ?? 'preparing'
      const { data: events } = await db.from('pipeline_events').select('sentence').eq('application_id', applicationId).eq('user_id', ctx.userId).order('created_at', { ascending: true }).limit(20)
      const steps = ((events as { sentence: string | null }[] | null) ?? []).flatMap((e) => (e.sentence ? [e.sentence.slice(0, 280)] : []))
      return { sentence: `Started ${(job as { title: string }).title}. It is now ${state.replace('_', ' ')}. Nothing was sent.`, application_id: applicationId, state, steps }
    }
    return scope ? withWorker(scope, { command: 'applications.start', title: `Preparing ${(job as { title: string }).title}`, object: { kind: 'role', ref: input.job_id } }, work) : work()
  },
})

export const pipelineCommands: AnyCommand[] = [applicationsStart]
