// The plan gate: a big ask waits for the person's plan before anything runs.
//
// After each model message, code counts the action items of the turn (never the model). Above PLAN_ABOVE, with no
// plan yet, it writes one plan row and one step row per pending item, titled from rows, and interrupts. The checkpoint
// holds the turn. The person removes or reorders, then Go ahead resumes it with { plan_id, keep }. The gate then
// issues the kept steps one at a time, in that order, as model messages of its own: no model call, no spend, so what
// runs is exactly what was approved. Rows are described in the split plan, section 1.1.

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { interrupt } from '@langchain/langgraph'
import { createMiddleware, type AgentMiddleware } from 'langchain'
import { keepCalls } from '@/lib/agents/middleware'
import type { AdminClient } from '@/lib/harness/types'
import type { WorkerScope } from './workers'

/** ponytail: one constant the owner sets; a setting when he wants one. */
export const PLAN_ABOVE = 3

/** What one step runs: exactly one tool call. */
export interface PlanStepObject {
  tool_call_id: string // the original call id, or `${callId}:${i}` for item i of a call split by role
  tool: 'applications_start' | 'documents_draft' | 'task'
  args: Record<string, unknown> // for applications_start always `{ job_id }` (one role per step)
}

export interface PlanInterrupt {
  kind: 'plan'
  plan_id: string
}

/** The resume value. keep: step row ids in the order to run them; null is Cancel, which run.ts handles itself. */
export interface PlanDecision {
  plan_id: string
  keep: string[] | null
}

type Args = Record<string, unknown>
const roleIds = (a: Args): string[] =>
  Array.isArray(a.job_ids) ? [...new Set(a.job_ids.filter((x): x is string => typeof x === 'string' && x !== ''))] : typeof a.job_id === 'string' && a.job_id ? [a.job_id] : []

/** How many items each action call touches, counted by code from its arguments. Any other tool counts 0. */
export const ACTION_ITEMS: Record<string, (args: Args) => number> = {
  applications_start: (a) => roleIds(a).length,
  documents_draft: () => 1,
  task: () => 1,
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)
const now = () => new Date().toISOString()

/** The step's title, read from rows (person_jobs, contacts), never from the model. Max 160 chars. */
export async function stepTitle(db: AdminClient, userId: string, tool: string, args: Args): Promise<string> {
  const job = async (id: unknown) => {
    if (typeof id !== 'string') return null
    const { data } = await db.from('person_jobs').select('title, viewer_company_name').eq('viewer_id', userId).eq('id', id).maybeSingle()
    return data as { title: string; viewer_company_name: string | null } | null
  }
  const at = (j: { title: string; viewer_company_name: string | null }) => (j.viewer_company_name ? `${j.title} at ${j.viewer_company_name}` : j.title)
  if (tool === 'applications_start') {
    const j = await job(args.job_id)
    return clip(j ? `Start an application: ${at(j)}` : 'Start an application: a role that is not in your stored roles', 160)
  }
  if (tool === 'documents_draft') {
    const word = typeof args.type === 'string' ? args.type.replace('_', ' ') : 'draft'
    const j = await job(args.job_id)
    if (j) return clip(`Write a ${word} for ${at(j)}`, 160)
    if (typeof args.contact_id === 'string') {
      const { data } = await db.from('contacts').select('name').eq('user_id', userId).eq('id', args.contact_id).maybeSingle()
      const name = (data as { name: string } | null)?.name
      if (name) return clip(`Write a ${word} to ${name}`, 160)
    }
    return `Write a ${word}`
  }
  // The same rule as celloTaskRows in lib/agents/middleware.ts.
  return 'Research: ' + String(args.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

type Call = { id?: string; name: string; args: Args }

const argKey = (a: Args) => JSON.stringify(Object.entries(a).sort(([x], [y]) => (x < y ? -1 : 1)))
/** True when the call would do what a step the person removed or stopped would have done. */
const asksForStopped = (call: Call, rows: Row[]) =>
  stepsOf(call).some((s) => rows.some((r) => r.status === 'stopped' && r.object?.tool === s.tool && argKey(r.object.args) === argKey(s.args)))

/** The steps one call stands for: none for a call that changes nothing, one per role for applications_start. */
function stepsOf(call: Call): PlanStepObject[] {
  const tool = call.name as PlanStepObject['tool']
  const id = String(call.id)
  if (!ACTION_ITEMS[tool]) return []
  if (tool !== 'applications_start') return ACTION_ITEMS[tool](call.args) ? [{ tool_call_id: id, tool, args: call.args }] : []
  const ids = roleIds(call.args)
  return ids.map((job_id, i) => ({ tool_call_id: ids.length === 1 ? id : `${id}:${i}`, tool, args: { job_id } }))
}

interface Row {
  id: string
  status: string
  branch_index: number | null
  object: PlanStepObject | null
  stop_requested_at: string | null
}

const aiCalls = (m: BaseMessage): Call[] => (AIMessage.isInstance(m) ? ((m.tool_calls ?? []) as Call[]) : [])

function must<T extends { error: { message: string } | null }>(r: T): T {
  if (r.error) throw new Error(`Cello could not save the plan: ${r.error.message}`)
  return r
}

export function planGate(scope: WorkerScope): AgentMiddleware {
  const { db, userId } = scope
  const table = () => db.from('agent_tasks')
  let approvedId: string | null = null // a plan that is done stays done: asked once

  const planRow = async (): Promise<{ id: string; status: string } | null> => {
    const { data } = await table().select('id, status').eq('user_id', userId).eq('turn_id', scope.turnId).eq('command', 'chat.plan').order('created_at').limit(1)
    return ((data as { id: string; status: string }[] | null) ?? [])[0] ?? null
  }
  const approved = async (): Promise<string | null> => {
    if (approvedId) return approvedId
    const plan = await planRow()
    return (approvedId = plan?.status === 'done' ? plan.id : null)
  }
  const children = async (planId: string): Promise<Row[]> => {
    const { data } = await table().select('id, command, status, branch_index, object, stop_requested_at').eq('user_id', userId).eq('parent_id', planId).order('branch_index')
    return (data as (Row & { command: string })[] | null) ?? []
  }
  const stepRows = async (planId: string) => (await children(planId)).filter((r) => (r as Row & { command: string }).command === 'chat.plan.step')
  const base = () => ({
    user_id: userId,
    thread_id: scope.threadId,
    chat_id: scope.chatId,
    turn_id: scope.turnId,
    model: scope.model ?? null,
    rung: scope.rung ?? null,
    heartbeat_at: now(),
  })
  const stopRow = async (id: string, summary: string) => {
    await table().update({ status: 'stopped', summary, finished_at: now(), heartbeat_at: now() }).eq('id', id)
  }

  /** The message with the first kept step as its only action call (non-action calls stay); null step: no action call. */
  const rewrite = (last: AIMessage, first: PlanStepObject | null): AIMessage => {
    const actions = new Set(((last.tool_calls ?? []) as Call[]).filter((c) => stepsOf(c).length).map((c) => c.id))
    const kept = keepCalls(last, (c) => !actions.has(c.id))
    if (!first) return kept
    const { tool_calls: _drop, ...kwargs } = kept.additional_kwargs
    return new AIMessage({
      content: kept.content,
      tool_calls: [...(kept.tool_calls ?? []), { id: first.tool_call_id, name: first.tool, args: first.args, type: 'tool_call' as const }],
      additional_kwargs: kwargs,
      response_metadata: kept.response_metadata,
      usage_metadata: kept.usage_metadata,
      id: last.id,
      name: last.name,
    })
  }

  return createMiddleware({
    name: 'CelloPlanGate',

    afterModel: async (state) => {
      const messages = state.messages as BaseMessage[]
      const last = messages.at(-1)
      if (!last || !AIMessage.isInstance(last) || !last.tool_calls?.length) return undefined
      const calls = last.tool_calls as Call[]
      let plan = await planRow()

      if (plan?.status === 'done') {
        // Calls the model adds after approval run as usual and are shown as added, once each.
        const rows = await stepRows(plan.id)
        const known = new Set((await children(plan.id)).map((r) => r.object?.tool_call_id).filter(Boolean) as string[])
        // A call for something the person took out is refused by wrapToolCall, so it is not an addition.
        const fresh = calls.flatMap((c) =>
          asksForStopped(c, rows) || [...known].some((k) => k === c.id || k.startsWith(`${c.id}:`)) ? [] : stepsOf(c)
        ).filter((s) => !known.has(s.tool_call_id))
        if (fresh.length) {
          const titles = await Promise.all(fresh.map((s) => stepTitle(db, userId, s.tool, s.args)))
          must(
            await table().insert(
              fresh.map((s, i) => ({ ...base(), command: 'chat.plan.added', parent_id: plan!.id, status: 'done', title: clip(`Added: ${titles[i]}`, 160), object: s, summary: 'Added after the plan started', started_at: now(), finished_at: now() }))
            )
          )
        }
        return undefined
      }
      // A cancelled plan: nothing of it runs.
      if (plan?.status === 'stopped') return { messages: [rewrite(last, null)] }

      if (!plan) {
        let count = 0
        const from = messages.reduce((n, m, i) => (HumanMessage.isInstance(m) ? i + 1 : n), 0)
        for (const m of messages.slice(from)) for (const c of aiCalls(m)) count += ACTION_ITEMS[c.name]?.(c.args ?? {}) ?? 0
        if (count <= PLAN_ABOVE) return undefined
        const pending = calls.flatMap(stepsOf)
        if (!pending.length) return undefined
        const titles = await Promise.all(pending.map((s) => stepTitle(db, userId, s.tool, s.args)))
        const word = pending.length === 1 ? 'thing' : 'things'
        const { data } = must(
          await table()
            .insert({ ...base(), command: 'chat.plan', parent_id: null, status: 'waiting', title: `Plan: ${pending.length} ${word}`, object: { ai_message_id: last.id ?? null } })
            .select('id')
            .single()
        )
        plan = data as { id: string; status: string }
        must(await table().insert(pending.map((s, i) => ({ ...base(), command: 'chat.plan.step', parent_id: plan!.id, status: 'queued', title: titles[i], object: s, branch_index: i }))))
      }

      // The node runs again from the top on resume: a waiting plan is reused as it is.
      const steps = await stepRows(plan.id)
      const decision = interrupt({ kind: 'plan', plan_id: plan.id } satisfies PlanInterrupt) as Partial<PlanDecision> | string | null
      const ids = new Set(steps.map((r) => r.id))
      const keep = typeof decision === 'object' && decision ? decision.keep : null
      if (typeof decision !== 'object' || !decision || decision.plan_id !== plan.id || !Array.isArray(keep) || !keep.length || new Set(keep).size !== keep.length || !keep.every((k) => ids.has(k))) {
        throw new Error('The plan answer does not match the plan.')
      }

      // ponytail: the plan row goes last, so a crash in between leaves a waiting plan this same code finishes; a crash
      // after it and before the checkpoint is saved would run the original calls. Upgrade: one rpc for all the writes.
      for (const [i, id] of keep.entries()) must(await table().update({ branch_index: i }).eq('id', id))
      const removed = steps.filter((r) => !keep.includes(r.id)).map((r) => r.id)
      if (removed.length) must(await table().update({ status: 'stopped', summary: 'Removed by you', finished_at: now() }).in('id', removed))
      must(await table().update({ status: 'done', summary: `Kept ${keep.length} of ${steps.length}`, finished_at: now() }).eq('id', plan.id))
      approvedId = plan.id
      const first = steps.find((r) => r.id === keep[0])!.object
      return { messages: [rewrite(last, first)] }
    },

    wrapModelCall: async (request, handler) => {
      const planId = await approved()
      if (!planId) return handler(request)
      const issued = new Set((request.messages as BaseMessage[]).flatMap(aiCalls).map((c) => c.id))
      for (const row of await stepRows(planId)) {
        if (row.status !== 'queued' || !row.object || issued.has(row.object.tool_call_id)) continue
        if (row.stop_requested_at) {
          await stopRow(row.id, 'Stopped by you')
          continue
        }
        const { tool_call_id: id, tool, args } = row.object
        return new AIMessage({ content: '', id: `plan-${row.id}`, tool_calls: [{ id, name: tool, args, type: 'tool_call' as const }] })
      }
      return handler(request)
    },

    wrapToolCall: async (request, handler) => {
      const callId = request.toolCall.id
      const planId = callId ? await approved() : null
      const row = planId ? (await stepRows(planId)).find((r) => r.status === 'queued' && r.object?.tool_call_id === callId) : undefined
      if (!row) {
        const call = request.toolCall as Call
        if (planId && asksForStopped(call, await stepRows(planId))) {
          return new ToolMessage({ content: 'The person removed this. Do not do it again.', tool_call_id: callId!, name: call.name })
        }
        return handler(request)
      }
      // Stop was pressed after approval and before this step began.
      if (row.stop_requested_at) {
        await stopRow(row.id, 'Stopped by you')
        return new ToolMessage({ content: 'The person stopped this before it started. Do not do it again.', tool_call_id: callId!, name: request.toolCall.name })
      }
      await table().update({ status: 'done', summary: 'Started', started_at: now(), finished_at: now(), heartbeat_at: now() }).eq('id', row.id)
      return handler(request)
    },
  }) as unknown as AgentMiddleware
}
