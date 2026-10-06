// pipeline, request_approval and schedule_task: moving things forward, asking the person, and scheduling.
//
// Nothing here sends. request_approval writes a row the person approves; the click runs
// the send. schedule_task cannot turn on acting without asking: "act within my rules" is
// the person's switch, never the model's, because the text that asked for it might have
// come from a job post.

import type { SupabaseClient } from '@supabase/supabase-js'
import { PIPELINE_STAGES } from '@cello/shared'
import { z } from 'zod'
import { getApplication } from '@/lib/harness/copilot-tools'
import { recordInteraction } from '@/lib/interactions/store'
import { getArtifact } from '../artifacts'
import { WAITING_COPY, autoApprove, queueApproval } from '../approvals'
import {
  EVERY,
  ScheduleError,
  WEEKDAYS,
  createScheduledTask,
  describeSchedule,
  getScheduledTask,
  specFromCron,
  updateScheduledTask,
  type ScheduleSpec,
} from '../schedules'
import { defineTool, keyFor, readFields, toolFix, writeFields, type CelloTool } from './common'

// --- pipeline -----------------------------------------------------------------------

export const pipeline = defineTool({
  name: 'pipeline',
  description:
    'Read or change the person\'s application pipeline. action list shows applications by stage, or one role\'s application when job_id is given. ' +
    'move changes an application\'s stage. attach adds a saved cover letter or resume to an application. ' +
    'Use it for "where am I with X" and "mark X as interviewing". It never sends or submits anything.',
  schema: z.object({
    action: z.enum(['list', 'move', 'attach']).describe('list reads, move changes the stage, attach adds a saved document.'),
    job_id: z.string().min(1).optional().describe('For list: show the application for this role.'),
    application_id: z.string().min(1).optional().describe('For move and attach: the application id from list.'),
    stage: z.enum(PIPELINE_STAGES).optional().describe('For move: the new stage.'),
    artifact_id: z.string().min(1).optional().describe('For attach: a cover_letter or resume artifact.'),
    ...readFields,
    ...writeFields,
  }),
  kind: 'write',
  untrusted: false,
  mcp: true,
  async handler(ctx, a) {
    if (a.action === 'list') {
      const out = (await getApplication(ctx, a.job_id ? { jobId: a.job_id } : {})) as Record<string, unknown>
      if (typeof out.error === 'string') return toolFix(out.error, 'Call find_roles and use an id it returned.')
      if (Array.isArray(out.recent)) out.recent = out.recent.slice(0, a.response_format === 'detailed' ? a.limit : Math.min(a.limit, 8))
      return out
    }
    if (!a.application_id) return toolFix(`${a.action} needs an application_id.`, 'Call pipeline with action list and use an applicationId from it.')
    const { data } = await ctx.admin.from('applications').select('id, job_id, stage, applied_at').eq('id', a.application_id).eq('user_id', ctx.userId).maybeSingle()
    const app = data as { id: string; job_id: string; stage: string; applied_at: string | null } | null
    if (!app) return toolFix(`No application with id ${a.application_id}.`, 'Call pipeline with action list and use an applicationId from it.')

    if (a.action === 'move') {
      if (!a.stage) return toolFix('move needs a stage.', `Use one of: ${PIPELINE_STAGES.join(', ')}.`)
      if (a.stage === app.stage) return { ok: true, application_id: app.id, stage: app.stage, note: 'Already in that stage.' }
      await ctx.admin
        .from('applications')
        .update({ stage: a.stage, updated_at: new Date().toISOString(), ...(a.stage === 'applied' && !app.applied_at ? { applied_at: new Date().toISOString() } : {}) })
        .eq('id', app.id)
        .eq('user_id', ctx.userId)
      await recordInteraction(ctx.admin as unknown as SupabaseClient, {
        userId: ctx.userId,
        jobId: app.job_id,
        applicationId: app.id,
        kind: 'stage_change',
        occurredAt: new Date().toISOString(),
        title: `Moved to ${a.stage}`,
        refTable: 'applications',
        refId: `${app.id}:${a.stage}`,
        metadata: { from: app.stage, to: a.stage, by: 'cello' },
      })
      return { ok: true, application_id: app.id, stage: a.stage, was: app.stage }
    }

    if (!a.artifact_id) return toolFix('attach needs an artifact_id.', 'Use an id returned by create_artifact.')
    const got = await getArtifact(ctx.admin, ctx.userId, a.artifact_id)
    if (!got) return toolFix(`No artifact with id ${a.artifact_id}.`, 'Use an id returned by create_artifact.')
    if (got.artifact.type === 'cover_letter') {
      await ctx.admin.from('applications').update({ cover_letter: got.version.content_text, updated_at: new Date().toISOString() }).eq('id', app.id).eq('user_id', ctx.userId)
    } else if (got.artifact.type === 'resume') {
      await ctx.admin.from('applications').update({ resume_version: `${got.artifact.title} (version ${got.version.version})`, updated_at: new Date().toISOString() }).eq('id', app.id).eq('user_id', ctx.userId)
    } else {
      return toolFix(`A ${got.artifact.type.replace('_', ' ')} cannot be attached to an application.`, 'Attach a cover_letter or a resume.')
    }
    return { ok: true, application_id: app.id, attached: got.artifact.type, version: got.version.version }
  },
}) satisfies CelloTool

// --- request_approval ---------------------------------------------------------------

export const requestApproval = defineTool({
  name: 'request_approval',
  description:
    'Ask the person to approve sending an email or submitting an application. Pass the artifact id of the finished draft. ' +
    'It returns at once with status waiting. The person approves in Needs you, and you are told the result in a later turn. Nothing is sent by this call. ' +
    'Use it as the last step, after the draft is ready and reviewed. Do not tell the person it was sent.',
  schema: z.object({
    action: z.enum(['send_email', 'submit_application']).describe('What the person is asked to approve.'),
    artifact_id: z.string().min(1).describe('The finished draft: a message for send_email, a cover_letter or resume for submit_application.'),
    contact_id: z.string().min(1).optional().describe('For send_email, if the email was not written for a contact.'),
    job_id: z.string().min(1).optional().describe('The role, if the draft was not written for one.'),
    ...writeFields,
  }),
  kind: 'write',
  untrusted: false,
  mcp: true,
  async handler(ctx, a, meta) {
    const queued = await queueApproval(ctx, { action: a.action, artifactId: a.artifact_id, contactId: a.contact_id, jobId: a.job_id, idempotencyKey: keyFor(ctx, meta, a.idempotency_key) })
    if (!queued.ok) return toolFix(queued.error, queued.fix)
    const { approval } = queued
    // A scheduled task set to act within its rules approves what its rules allow, through the same code as the person's click.
    // Over MCP nothing is ever approved here.
    if (meta.channel === 'agent' && ctx.scheduledTaskId && approval.status === 'pending') {
      const result = await autoApprove({ autonomy: ctx.autonomy, rules: ctx.rules ?? {} }, approval, {
        supabase: ctx.admin as unknown as SupabaseClient,
        admin: ctx.admin,
        user: { id: ctx.userId, email: ctx.userEmail },
      })
      if (result) return { status: result.approval?.status === 'done' ? 'approved_by_rule' : 'not_sent', approval_id: approval.id, message: result.copy }
    }
    return { status: 'waiting', approval_id: approval.id, message: WAITING_COPY, ...(queued.created ? {} : { note: 'This was already queued.' }) }
  },
}) satisfies CelloTool

// --- schedule_task ------------------------------------------------------------------

export const scheduleTask = defineTool({
  name: 'schedule_task',
  description:
    'Create or change a scheduled task: something Cello does on a schedule, such as finding new roles every morning. every is day, weekday, week or hours. ' +
    'at is a 24 hour time like "08:00". timezone is an IANA name like "America/Los_Angeles". autonomy is ask (ask before every action) or draft (draft everything, the person approves sends). ' +
    'Pass task_id to change an existing task, or status paused to pause one. Use it only when the person asks for something on a schedule.',
  schema: z.object({
    task_id: z.string().min(1).optional().describe('An existing task to change. Leave out to create one.'),
    name: z.string().min(1).max(80).optional().describe('A short name, for example "Find new roles". Needed when creating.'),
    instruction: z.string().min(1).max(2000).optional().describe('What to do each time, in the person\'s words. Needed when creating.'),
    every: z.enum(EVERY).optional().describe('Needed when creating.'),
    at: z.string().max(5).optional().describe('24 hour time, default 08:00.'),
    weekday: z.enum(WEEKDAYS).optional().describe('For every week.'),
    hours: z.number().int().min(1).max(12).optional().describe('For every hours: run every this many hours.'),
    timezone: z.string().max(64).optional().describe('IANA time zone. Needed when creating.'),
    autonomy: z.enum(['ask', 'draft', 'act']).default('ask').describe('act is turned on by the person in Scheduled tasks, not by you.'),
    status: z.enum(['active', 'paused']).optional().describe('paused stops it running until set active again.'),
    ...writeFields,
  }),
  kind: 'write',
  untrusted: false,
  mcp: true,
  async handler(ctx, a) {
    // A demo has a small budget and an end date; a repeating task would spend it after they leave.
    if (ctx.isDemo) return toolFix('Demo accounts cannot schedule tasks.', 'Tell the person this needs a full account.')
    // A task that is running cannot create or change tasks: text it read must not be able to set up its own repeat.
    if (ctx.scheduledTaskId) return toolFix('A scheduled task cannot create or change scheduled tasks.', 'Tell the person in your result what they could schedule.')
    // The person alone can turn on acting. A request for it saves "draft" and says what is left to do.
    const asked = a.autonomy
    const autonomy = asked === 'act' ? 'draft' : asked
    const needsPerson = asked === 'act' ? 'Act within my rules is turned on by the person in Scheduled tasks. This task drafts and asks before sending.' : undefined

    try {
      if (a.task_id) {
        const existing = await getScheduledTask(ctx.admin, ctx.userId, a.task_id)
        if (!existing) return toolFix(`No scheduled task with id ${a.task_id}.`, 'Call schedule_task without task_id to create one.')
        const schedule: ScheduleSpec | undefined = a.every ? { every: a.every, at: a.at, weekday: a.weekday, hours: a.hours, timezone: a.timezone ?? existing.timezone } : undefined
        const updated = await updateScheduledTask(ctx.admin, ctx.userId, a.task_id, {
          name: a.name,
          instruction: a.instruction,
          schedule,
          // Never raise autonomy on an existing task from here: only keep or lower it.
          autonomy: asked === 'act' ? undefined : a.autonomy,
          status: a.status,
        })
        if (!updated) return toolFix('Could not change that task.', 'Try again.')
        return { ok: true, task_id: updated.id, name: updated.name, schedule: describeScheduleOf(updated.cron, updated.timezone), next_run_at: updated.next_run_at, status: updated.status, autonomy: updated.autonomy, ...(needsPerson ? { needs_person: needsPerson } : {}) }
      }
      if (!a.name || !a.instruction || !a.every || !a.timezone) {
        return toolFix('Creating a task needs name, instruction, every and timezone.', 'Ask the person for what is missing, for example their time zone.')
      }
      const created = await createScheduledTask(ctx.admin, ctx.userId, {
        name: a.name,
        instruction: a.instruction,
        schedule: { every: a.every, at: a.at, weekday: a.weekday, hours: a.hours, timezone: a.timezone },
        autonomy,
      })
      return { ok: true, task_id: created.id, name: created.name, schedule: describeScheduleOf(created.cron, created.timezone), next_run_at: created.next_run_at, autonomy: created.autonomy, ...(needsPerson ? { needs_person: needsPerson } : {}) }
    } catch (e) {
      if (e instanceof ScheduleError) return toolFix(e.message, e.fix)
      throw e
    }
  },
}) satisfies CelloTool

function describeScheduleOf(cron: string, timezone: string): string {
  return describeSchedule(specFromCron(cron, timezone))
}
