// Running a Chat turn from a route: the person's words are already stored as their turn; this recalls from earlier
// chats, resolves the model, runs the loop under one root worker row ("Cello is working", with Stop), and leaves an
// answer or a plain line saying nothing was changed, so the page never waits on a turn that has ended.

import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { openAgentPersistence } from '@/lib/agents/persistence'
import { profileCard } from '@/lib/agents/profile-card'
import { claimLease, fireContinue, releaseLease, renewLease } from '@/lib/agents/scheduler'
import { startHeartbeat } from '@/lib/agents/tasks'
import { loadApiKeys } from '@/lib/harness/keys'
import type { AdminClient } from '@/lib/harness/types'
import { getMemoryStore } from '@/lib/memory/mem0-store'
import { NO_MODEL_LINE, reasonOf } from '@/lib/models/caps'
import { chatLimits } from '@/lib/models/choice'
import { freeModels } from '@/lib/models/free'
import { chatAgent } from './agent'
import { resolveMode, stripKeyword } from './mode'
import { recall, type RecallHit } from './recall'
import { readSettings } from './settings'
import { routedAgent } from './route'
import { recallInWordsOn } from './shown'
import { runChatTurn } from './turn'
import { INTERRUPTED, turnApplications, writeRollup } from './rollup'
import { finishWorker, isStopped, MOVED_LINE, MovedError, openWorker, PlanWaitingError, STOP_POLL_MS } from './workers'
import type { PlanDecision } from './plan'
import type { WireEvent } from '@/lib/agents/sse'
const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter' } as const

export interface StoredPersonTurn {
  id: string
  typed: string
  quoted: { text: string; turn_id: string } | null
}

/** Stores the person's words before streaming or any model work starts. */
export async function storePersonTurn(
  db: AdminClient,
  userId: string,
  chatId: string,
  input: { typed: string; quoted?: { text: string; turn_id: string } | null },
): Promise<StoredPersonTurn | null> {
  const typed = input.typed.trim()
  if (!typed || typed.length > 20_000) return null
  const { data: chat } = await db.from('chats').select('id, title').eq('id', chatId).eq('user_id', userId).maybeSingle()
  if (!chat) return null
  const quoted = input.quoted ?? null
  const { data: made, error } = await db.from('chat_turns').insert({ user_id: userId, chat_id: chatId, kind: 'person', typed, origin: 'person', quoted }).select('id').single()
  if (error || !made) return null
  if (!(chat as { title: string | null }).title) await db.from('chats').update({ title: typed.replace(/\s+/g, ' ').slice(0, 80) }).eq('id', chatId).eq('user_id', userId)
  return { id: (made as { id: string }).id, typed, quoted }
}


const NOTHING_CHANGED = 'Nothing was changed.'

/** Rows of the plan (the plan, its steps and the ones added) are the person's to-do list, not work: readers leave them out. */
const isPlanRow = (r: { command: string }) => r.command.startsWith('chat.plan')

/** The turn's work rows: the root and the plan's rows are left out. */
async function workRows(db: AdminClient, userId: string, turnId: string): Promise<{ id: string; status: string; finished_at: string | null }[]> {
  const { data } = await db.from('agent_tasks').select('id, command, status, finished_at').eq('user_id', userId).eq('turn_id', turnId).neq('command', 'chat.turn')
  return ((data as { id: string; command: string; status: string; finished_at: string | null }[] | null) ?? []).filter((r) => !isPlanRow(r))
}

const KEPT = 'What was already done is kept.'
export const CANCEL_LINE = 'Cancelled. Nothing was changed.'
export const BUSY_LINE = 'Cello is still finishing something in this chat. Try again in a minute.'

/** The line a turn leaves when it ends without an answer. "Nothing was changed" is only true when no worker of the turn finished and no application was made, whatever state its row ended in. The applications are named: they are Cello's work the person now owns. */
async function leaveLine(db: AdminClient, userId: string, chatId: string, text: string, turnId?: string) {
  let about: { kind: 'application'; ref: string }[] = []
  if (turnId && text.includes(NOTHING_CHANGED)) {
    const finished = (await workRows(db, userId, turnId)).filter((r) => ['done', 'partial'].includes(r.status))
    const made = await turnApplications(db, userId, chatId, turnId).catch(() => [])
    if (finished.length > 0 || made.length > 0) text = text.replace(NOTHING_CHANGED, KEPT)
    if (made.length > 0) {
      text = `${text} Already started: ${made.map((a) => `[${a.name}](cello:application/${a.id})`).join(', ')}.`
      about = made.map((a) => ({ kind: 'application' as const, ref: a.id }))
    }
  }
  await db.from('chat_turns').insert({ user_id: userId, chat_id: chatId, kind: 'cello', answer: text, origin: 'code', prov: { step: 'chat', rule: 'refusal' }, parts: [{ about, text }], links: about.map((a) => ({ kind: 'application', table: 'applications', id: a.ref, role: 'named' })) })
  await db.from('chats').update({ last_turn_at: new Date().toISOString() }).eq('id', chatId).eq('user_id', userId)
}

/** Deletes the checkpoints of turns that will never be carried on. No checkpointer here means nothing was kept. */
async function dropCheckpoints(turnIds: string[], open: NonNullable<RunStoredTurnOptions['openPersistence']> = openAgentPersistence) {
  if (!turnIds.length) return
  try {
    const kept = open()
    for (const id of turnIds) await kept.saver.deleteThread(id).catch(() => undefined)
    await kept.close().catch(() => undefined)
  } catch {
    // no checkpointer here: nothing was kept
  }
}

/** Ends a plan that was waiting: its planned steps, the plan and the turn's root row stop, with `why` on the steps and the plan. False when the plan was not waiting any more. */
async function endPlan(db: AdminClient, userId: string, plan: { id: string; turnId: string }, why: string): Promise<boolean> {
  const at = new Date().toISOString()
  const { data } = await db.from('agent_tasks').update({ status: 'stopped', summary: why, finished_at: at }).eq('id', plan.id).eq('user_id', userId).eq('command', 'chat.plan').eq('status', 'waiting').select('id')
  if (((data as unknown[] | null) ?? []).length === 0) return false
  await db.from('agent_tasks').update({ status: 'stopped', summary: why, finished_at: at }).eq('user_id', userId).eq('parent_id', plan.id).eq('command', 'chat.plan.step').eq('status', 'queued')
  await db.from('agent_tasks').update({ status: 'stopped', finished_at: at }).eq('user_id', userId).eq('turn_id', plan.turnId).eq('command', 'chat.turn').is('finished_at', null)
  return true
}

/** A new message in the chat ends every plan still waiting in it, with no line. */
async function cancelWaitingPlans(db: AdminClient, userId: string, chatId: string, open?: RunStoredTurnOptions['openPersistence']) {
  const { data } = await db.from('agent_tasks').select('id, turn_id').eq('user_id', userId).eq('chat_id', chatId).eq('command', 'chat.plan').eq('status', 'waiting')
  const ended: string[] = []
  for (const plan of (data as { id: string; turn_id: string }[] | null) ?? []) if (await endPlan(db, userId, { id: plan.id, turnId: plan.turn_id }, 'Cancelled when you asked something else')) ended.push(plan.turn_id)
  await dropCheckpoints(ended, open)
}

/** The most requests one turn may take: after this many hand-overs it stops with what it has. */
export const MAX_SLICES = 5
const CAP_LINE = 'This took longer than Cello allows for one message, so it stopped. What was done is kept. Ask for the rest in a new message.'

export interface RunStoredTurnOptions {
  emit?: (event: WireEvent) => void
  /** Carry on a turn whose root row exists: reuse it, never open a new "Cello is working" row. `value` is the plan decision that answers the interrupt the turn waits on. */
  resume?: { rootId: string; slices: number; value?: PlanDecision }
  /** Test seam: the checkpointer. Defaults to openAgentPersistence() (lib/agents/persistence.ts). */
  openPersistence?: () => { saver: BaseCheckpointSaver; close: () => Promise<void> }
}

/** Resolves false only when `resume` was asked and another request holds the chat (nothing ran). */
export async function runStoredTurn(
  db: AdminClient,
  userId: string,
  chatId: string,
  turn: { id: string; typed: string; quoted?: { text: string; turn_id: string } | null },
  options: RunStoredTurnOptions = {},
): Promise<boolean> {
  const slices = options.resume?.slices ?? 0
  // A turn that is carried on already has its row: when it cannot run, the row says so instead of working forever.
  // One request at a time runs a chat. A fresh turn whose chat is busy carries on without the lease (its row keeps the
  // sweeper away); a turn being carried on stands down before it touches anything, so a live turn is never run twice
  // and its working rows are never marked failed.
  const lease = await claimLease(db, chatId).catch(() => null)
  if (options.resume && !lease) return false
  const bail = async (text: string) => {
    await leaveLine(db, userId, chatId, text, turn.id)
    if (options.resume) await finishWorker(db, options.resume.rootId, { status: 'failed' })
    if (lease) await releaseLease(db, lease).catch(() => undefined)
    return true
  }
  const keys = await loadApiKeys(db, userId)
  const view = await readSettings(db, userId, chatId, chatLimits(keys), freeModels())
  // A saved key that cannot be read any more is the reason, not a missing one.
  if (!view?.ran) return bail(keys.unreadable?.length ? `Cello could not read your saved ${PROVIDER_NAMES[keys.unreadable[0]]} key. Save it again in Settings, under Models.` : NO_MODEL_LINE)
  // The mode is code's decision before anything runs: the keyword in the typed line, the chat's setting or Settings, held
  // to Send for me, Pause and the demo flag. The keyword is taken out of what the router and the model read; the stored
  // line keeps it. Only the door carries the mode: no command input and no model can set it.
  const mode = resolveMode({ typed: turn.typed, chat: view.mode.chat, settings: view.mode.settings, ...view.mode.facts })
  const typed = stripKeyword(turn.typed)
  if (!typed) return bail('There is nothing to send with the keyword alone. Say what to do.')

  let recalled: RecallHit[] = []
  if (await recallInWordsOn(db)) recalled = await recall(db, getMemoryStore(), userId, typed).catch(() => [])

  const scope = { db, userId, threadId: chatId, chatId, turnId: turn.id, model: view.ran.model, rung: view.ran.rung }
  // A new message ends any plan the person never answered: nothing of it runs, and it leaves no line.
  if (!options.resume) await cancelWaitingPlans(db, userId, chatId, options.openPersistence)
  const root = options.resume ? options.resume.rootId : await openWorker(scope, { command: 'chat.turn', title: 'Cello is working' })
  if (options.resume) {
    // A plan that was waiting works again: the root row says so before anything else.
    await db.from('agent_tasks').update({ status: 'working', heartbeat_at: new Date().toISOString() }).eq('id', root).eq('user_id', userId)
    // What was in flight when the request died: finished here (the lease is ours, so nothing live is touched), and its call runs again under the same call key. The plan's rows are not work in flight: a planned step is waiting its turn.
    const open = (await workRows(db, userId, turn.id)).filter((r) => !r.finished_at).map((r) => r.id)
    if (open.length) await db.from('agent_tasks').update({ status: 'failed', summary: INTERRUPTED, finished_at: new Date().toISOString() }).in('id', open)
  }
  const stopBeat = startHeartbeat(db, root, lease ? () => renewLease(db, lease) : undefined)
  const stop = new AbortController()
  const timer = setInterval(() => void isStopped(db, root).then((yes) => yes && stop.abort()), STOP_POLL_MS)
  let persistence: ReturnType<NonNullable<RunStoredTurnOptions['openPersistence']>> | undefined
  let moved = false
  let waiting = false
  try {
    // Without a checkpointer the turn still runs; it just cannot be carried on.
    try {
      persistence = (options.openPersistence ?? openAgentPersistence)()
    } catch (e) {
      console.error('chat checkpointer unavailable', e)
    }
    try {
      const card = await profileCard(db, userId).catch(() => undefined)
      const loop = chatAgent({ db, userId, keys, isDemo: keys.isDemo !== false, ran: view.ran, roles: view.roles, mode: mode.mode, signal: stop.signal, stop: () => isStopped(db, root), emit: options.emit, saver: persistence?.saver, resume: Boolean(options.resume), resumeValue: options.resume?.value, profileCard: card })
      const names = async () => (((await db.from('companies').select('name').eq('user_id', userId).limit(200)).data as { name: string }[] | null) ?? []).map((c) => c.name)
      const out = await runChatTurn(
        { db, agent: routedAgent({ db, userId, keys, ran: view.ran, roles: view.roles, mode: mode.mode, signal: stop.signal, stop: () => isStopped(db, root), emit: options.emit }, loop, names), store: getMemoryStore(), isDemo: keys.isDemo !== false },
        { userId, chatId, typed, quoted: turn.quoted ?? null, recalled, turnId: turn.id, mode }
      )
      const stopped = stop.signal.aborted || (await isStopped(db, root))
      if (!out.ok) await leaveLine(db, userId, chatId, stopped ? 'Stopped. Nothing was changed.' : `${out.error} ${out.fix}`.trim(), turn.id)
      await finishWorker(db, root, { status: stopped ? 'stopped' : out.ok ? 'done' : 'failed' })
      options.emit?.({ event: 'custom', data: { type: 'answer', turn_id: turn.id } })
    } catch (e) {
      if (e instanceof PlanWaitingError) {
        // The plan is saved and nothing of it has run: no line, no answer, no clean-up. The row waits for the person.
        waiting = true
        if (root) await db.from('agent_tasks').update({ status: 'waiting', heartbeat_at: new Date().toISOString() }).eq('id', root).eq('user_id', userId)
        options.emit?.({ event: 'custom', data: { type: 'plan', plan_id: e.planId, turn_id: turn.id } })
      } else if (e instanceof MovedError && slices + 1 < MAX_SLICES) {
        // The checkpoint is saved and the row keeps working: no line, no answer. Another request carries on.
        moved = true
        options.emit?.({ event: 'custom', data: { type: 'moved', text: MOVED_LINE } })
      } else {
        console.error('chat turn failed', e)
        const stopped = stop.signal.aborted || (await isStopped(db, root))
        await leaveLine(db, userId, chatId, e instanceof MovedError ? CAP_LINE : stopped ? 'Stopped. Nothing was changed.' : (reasonOf(e, 'chat') ?? 'Cello could not finish this. Nothing was changed. Try again.'), turn.id)
        await finishWorker(db, root, { status: stopped ? 'stopped' : 'failed' })
        options.emit?.({ event: 'custom', data: { type: 'answer', turn_id: turn.id } })
      }
    }
    if (!moved && !waiting) {
      // The turn is over: no row of it may go on looking busy, and the checkpoint has done its job.
      // A row the person stopped is stopped, not failed, whatever its work was still doing when the turn ended.
      await db.from('agent_tasks').update({ status: 'stopped', finished_at: new Date().toISOString() }).eq('user_id', userId).eq('turn_id', turn.id).neq('command', 'chat.turn').is('finished_at', null).not('stop_requested_at', 'is', null)
      await db.from('agent_tasks').update({ status: 'failed', summary: 'Did not finish.', finished_at: new Date().toISOString() }).eq('user_id', userId).eq('turn_id', turn.id).neq('command', 'chat.turn').is('finished_at', null)
      const count = (await workRows(db, userId, turn.id)).length
      if (options.resume || count >= 2) await writeRollup(db, userId, chatId, turn.id).catch((e) => console.error('rollup failed', e))
      await persistence?.saver.deleteThread(turn.id).catch(() => undefined)
    }
  } finally {
    clearInterval(timer)
    stopBeat()
    if (lease) await releaseLease(db, lease).catch(() => undefined)
    await persistence?.close().catch(() => undefined)
  }
  // After the lease is back and the pool is closed, so the request that carries on can take both.
  if (moved) await fireContinue({ reason: 'slice', thread_id: chatId, turn_id: turn.id, slice: { n: slices + 1 } })
  return true
}

/** Carries on an unfinished chat turn: its own root row, its own checkpoint. False when there is nothing to resume or another request holds the chat. */
export async function resumeChatTurn(db: AdminClient, chatId: string, turnId?: string, slices = 0): Promise<boolean> {
  // A turn waiting for the person's answer to a plan is not carried on by anyone else.
  let find = db.from('agent_tasks').select('id, user_id, turn_id').eq('thread_id', chatId).eq('command', 'chat.turn').is('finished_at', null).neq('status', 'waiting')
  if (turnId) find = find.eq('turn_id', turnId)
  const { data } = await find.order('created_at', { ascending: false }).limit(1).maybeSingle()
  const root = data as { id: string; user_id: string; turn_id: string } | null
  if (!root) return false
  // The person comes from the row, never from the request that asked.
  const userId = root.user_id
  const { data: person } = await db.from('chat_turns').select('id, typed, quoted, created_at').eq('id', root.turn_id).eq('user_id', userId).eq('chat_id', chatId).eq('kind', 'person').maybeSingle()
  if (!person) {
    await finishWorker(db, root.id, { status: 'failed' })
    return false
  }
  const p = person as { id: string; typed: string; quoted: { text: string; turn_id: string } | null; created_at: string }
  const { data: later } = await db.from('chat_turns').select('prov').eq('chat_id', chatId).eq('user_id', userId).eq('kind', 'cello').gte('created_at', p.created_at)
  if (((later as { prov: { turn_id?: string } | null }[] | null) ?? []).some((r) => r.prov?.turn_id === root.turn_id)) {
    await finishWorker(db, root.id, { status: 'done' })
    await writeRollup(db, userId, chatId, root.turn_id).catch(() => false)
    // A request that died between the stored answer and the clean-up leaves the checkpoint behind: it goes now.
    try {
      const left = openAgentPersistence()
      await left.saver.deleteThread(root.turn_id).catch(() => undefined)
      await left.close().catch(() => undefined)
    } catch {
      // no checkpointer here: nothing was kept
    }
    return true
  }
  return runStoredTurn(db, userId, chatId, { id: p.id, typed: p.typed, quoted: p.quoted }, { resume: { rootId: root.id, slices } })
}

export interface WaitingPlan {
  planId: string
  turnId: string
  rootId: string
  stepIds: string[]
}

/** The chat's plan `planId` when it is waiting: the plan row, its planned steps in order, and the turn's waiting root row. Null otherwise. */
export async function findWaitingPlan(db: AdminClient, userId: string, chatId: string, planId: string): Promise<WaitingPlan | null> {
  const { data: plan } = await db.from('agent_tasks').select('id, turn_id').eq('id', planId).eq('user_id', userId).eq('chat_id', chatId).eq('command', 'chat.plan').eq('status', 'waiting').maybeSingle()
  if (!plan) return null
  const turnId = (plan as { turn_id: string }).turn_id
  const { data: root } = await db.from('agent_tasks').select('id').eq('user_id', userId).eq('chat_id', chatId).eq('turn_id', turnId).eq('command', 'chat.turn').eq('status', 'waiting').is('finished_at', null).maybeSingle()
  if (!root) return null
  const { data: steps } = await db.from('agent_tasks').select('id').eq('user_id', userId).eq('chat_id', chatId).eq('parent_id', planId).eq('command', 'chat.plan.step').eq('status', 'queued').order('branch_index', { ascending: true })
  return { planId, turnId, rootId: (root as { id: string }).id, stepIds: ((steps as { id: string }[] | null) ?? []).map((r) => r.id) }
}

/** Go ahead or Cancel. Cancel stops the plan's rows, leaves one plain line and drops the checkpoint without running anything. Go ahead carries the turn on with the decision; false when another request holds the chat. */
export async function resumePlanTurn(
  db: AdminClient,
  userId: string,
  chatId: string,
  plan: WaitingPlan,
  decision: PlanDecision,
  options: Pick<RunStoredTurnOptions, 'emit' | 'openPersistence'> = {},
): Promise<boolean> {
  const answered = () => options.emit?.({ event: 'custom', data: { type: 'answer', turn_id: plan.turnId } })
  if (decision.keep === null) {
    // A second Cancel finds the plan already ended and adds nothing.
    if (await endPlan(db, userId, { id: plan.planId, turnId: plan.turnId }, 'Cancelled by you')) {
      await leaveLine(db, userId, chatId, CANCEL_LINE, plan.turnId)
      await dropCheckpoints([plan.turnId], options.openPersistence)
    }
    answered()
    return true
  }
  const { data: person } = await db.from('chat_turns').select('id, typed, quoted').eq('id', plan.turnId).eq('user_id', userId).eq('chat_id', chatId).eq('kind', 'person').maybeSingle()
  if (!person) {
    await endPlan(db, userId, { id: plan.planId, turnId: plan.turnId }, 'Cancelled when you asked something else')
    await leaveLine(db, userId, chatId, 'Cello could not find the message this plan came from. Nothing was changed. Ask again in a new message.')
    answered()
    return true
  }
  const p = person as { id: string; typed: string; quoted: { text: string; turn_id: string } | null }
  return runStoredTurn(db, userId, chatId, { id: p.id, typed: p.typed, quoted: p.quoted }, { emit: options.emit, openPersistence: options.openPersistence, resume: { rootId: plan.rootId, slices: 0, value: decision } })
}
