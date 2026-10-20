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
import { writeRollup } from './rollup'
import { finishWorker, isStopped, MOVED_LINE, MovedError, openWorker, STOP_POLL_MS } from './workers'
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


async function leaveLine(db: AdminClient, userId: string, chatId: string, text: string) {
  await db.from('chat_turns').insert({ user_id: userId, chat_id: chatId, kind: 'cello', answer: text, origin: 'code', prov: { step: 'chat', rule: 'refusal' }, parts: [{ about: [], text }] })
  await db.from('chats').update({ last_turn_at: new Date().toISOString() }).eq('id', chatId).eq('user_id', userId)
}

/** The most requests one turn may take: after this many hand-overs it stops with what it has. */
export const MAX_SLICES = 5
const CAP_LINE = 'This took longer than Cello allows for one message, so it stopped. What was done is kept. Ask for the rest in a new message.'

export interface RunStoredTurnOptions {
  emit?: (event: WireEvent) => void
  /** Carry on a turn whose root row exists: reuse it, never open a new "Cello is working" row. */
  resume?: { rootId: string; slices: number }
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
  const bail = async (text: string) => {
    await leaveLine(db, userId, chatId, text)
    if (options.resume) await finishWorker(db, options.resume.rootId, { status: 'failed' })
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
  const root = options.resume ? options.resume.rootId : await openWorker(scope, { command: 'chat.turn', title: 'Cello is working' })
  // One request at a time runs a chat. A fresh turn whose chat is busy carries on without the lease (its row keeps the
  // sweeper away); a turn being carried on stands down, so a live turn is never run twice.
  const lease = await claimLease(db, chatId).catch(() => null)
  if (options.resume && !lease) return false
  const stopBeat = startHeartbeat(db, root, lease ? () => renewLease(db, lease) : undefined)
  const stop = new AbortController()
  const timer = setInterval(() => void isStopped(db, root).then((yes) => yes && stop.abort()), STOP_POLL_MS)
  let persistence: ReturnType<NonNullable<RunStoredTurnOptions['openPersistence']>> | undefined
  let moved = false
  try {
    // Without a checkpointer the turn still runs; it just cannot be carried on.
    try {
      persistence = (options.openPersistence ?? openAgentPersistence)()
    } catch (e) {
      console.error('chat checkpointer unavailable', e)
    }
    try {
      const card = await profileCard(db, userId).catch(() => undefined)
      const loop = chatAgent({ db, userId, keys, isDemo: keys.isDemo !== false, ran: view.ran, roles: view.roles, mode: mode.mode, signal: stop.signal, stop: () => isStopped(db, root), emit: options.emit, saver: persistence?.saver, resume: Boolean(options.resume), profileCard: card })
      const names = async () => (((await db.from('companies').select('name').eq('user_id', userId).limit(200)).data as { name: string }[] | null) ?? []).map((c) => c.name)
      const out = await runChatTurn(
        { db, agent: routedAgent({ db, userId, keys, ran: view.ran, roles: view.roles, mode: mode.mode, signal: stop.signal, stop: () => isStopped(db, root), emit: options.emit }, loop, names), store: getMemoryStore(), isDemo: keys.isDemo !== false },
        { userId, chatId, typed, quoted: turn.quoted ?? null, recalled, turnId: turn.id, mode }
      )
      const stopped = stop.signal.aborted || (await isStopped(db, root))
      if (!out.ok) await leaveLine(db, userId, chatId, stopped ? 'Stopped. Nothing was changed.' : `${out.error} ${out.fix}`.trim())
      await finishWorker(db, root, { status: stopped ? 'stopped' : out.ok ? 'done' : 'failed' })
      options.emit?.({ event: 'custom', data: { type: 'answer', turn_id: turn.id } })
    } catch (e) {
      if (e instanceof MovedError && slices + 1 < MAX_SLICES) {
        // The checkpoint is saved and the row keeps working: no line, no answer. Another request carries on.
        moved = true
        options.emit?.({ event: 'custom', data: { type: 'moved', text: MOVED_LINE } })
      } else {
        console.error('chat turn failed', e)
        const stopped = stop.signal.aborted || (await isStopped(db, root))
        await leaveLine(db, userId, chatId, e instanceof MovedError ? CAP_LINE : stopped ? 'Stopped. Nothing was changed.' : (reasonOf(e, 'chat') ?? 'Cello could not finish this. Nothing was changed. Try again.'))
        await finishWorker(db, root, { status: stopped ? 'stopped' : 'failed' })
        options.emit?.({ event: 'custom', data: { type: 'answer', turn_id: turn.id } })
      }
    }
    if (!moved) {
      // The turn is over: no row of it may go on looking busy, and the checkpoint has done its job.
      await db.from('agent_tasks').update({ status: 'failed', summary: 'Did not finish.', finished_at: new Date().toISOString() }).eq('user_id', userId).eq('turn_id', turn.id).neq('command', 'chat.turn').is('finished_at', null)
      const { count } = await db.from('agent_tasks').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('turn_id', turn.id).neq('command', 'chat.turn')
      if (options.resume || (count ?? 0) >= 2) await writeRollup(db, userId, chatId, turn.id).catch((e) => console.error('rollup failed', e))
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
  let find = db.from('agent_tasks').select('id, user_id, turn_id').eq('thread_id', chatId).eq('command', 'chat.turn').is('finished_at', null)
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
    return true
  }
  // What was in flight when the request died: finished here, and its call runs again under the same call key.
  await db.from('agent_tasks').update({ status: 'failed', summary: 'Interrupted. Cello picked this up again.', finished_at: new Date().toISOString() }).eq('user_id', userId).eq('turn_id', root.turn_id).neq('command', 'chat.turn').is('finished_at', null)
  return runStoredTurn(db, userId, chatId, { id: p.id, typed: p.typed, quoted: p.quoted }, { resume: { rootId: root.id, slices } })
}
