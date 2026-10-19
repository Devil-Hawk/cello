// Running a Chat turn from a route: the person's words are already stored as their turn; this recalls from earlier
// chats, resolves the model, runs the loop under one root worker row ("Cello is working", with Stop), and leaves an
// answer or a plain line saying nothing was changed, so the page never waits on a turn that has ended.

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
import { finishWorker, isStopped, openWorker, STOP_POLL_MS } from './workers'
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

export interface RunStoredTurnOptions {
  emit?: (event: WireEvent) => void
}

export async function runStoredTurn(
  db: AdminClient,
  userId: string,
  chatId: string,
  turn: { id: string; typed: string; quoted?: { text: string; turn_id: string } | null },
  options: RunStoredTurnOptions = {},
): Promise<void> {
  const keys = await loadApiKeys(db, userId)
  const view = await readSettings(db, userId, chatId, chatLimits(keys), freeModels())
  // A saved key that cannot be read any more is the reason, not a missing one.
  if (!view?.ran) return leaveLine(db, userId, chatId, keys.unreadable?.length ? `Cello could not read your saved ${PROVIDER_NAMES[keys.unreadable[0]]} key. Save it again in Settings, under Models.` : NO_MODEL_LINE)
  // The mode is code's decision before anything runs: the keyword in the typed line, the chat's setting or Settings, held
  // to Send for me, Pause and the demo flag. The keyword is taken out of what the router and the model read; the stored
  // line keeps it. Only the door carries the mode: no command input and no model can set it.
  const mode = resolveMode({ typed: turn.typed, chat: view.mode.chat, settings: view.mode.settings, ...view.mode.facts })
  const typed = stripKeyword(turn.typed)
  if (!typed) return leaveLine(db, userId, chatId, 'There is nothing to send with the keyword alone. Say what to do.')

  let recalled: RecallHit[] = []
  if (await recallInWordsOn(db)) recalled = await recall(db, getMemoryStore(), userId, typed).catch(() => [])

  const scope = { db, userId, threadId: chatId, chatId, turnId: turn.id, model: view.ran.model, rung: view.ran.rung }
  const root = await openWorker(scope, { command: 'chat.turn', title: 'Cello is working' })
  const stop = new AbortController()
  const timer = setInterval(() => void isStopped(db, root).then((yes) => yes && stop.abort()), STOP_POLL_MS)
  try {
    const loop = chatAgent({ db, userId, keys, isDemo: keys.isDemo !== false, ran: view.ran, roles: view.roles, mode: mode.mode, signal: stop.signal, stop: () => isStopped(db, root), emit: options.emit })
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
    console.error('chat turn failed', e)
    const stopped = stop.signal.aborted || (await isStopped(db, root))
    await leaveLine(db, userId, chatId, stopped ? 'Stopped. Nothing was changed.' : (reasonOf(e, 'chat') ?? 'Cello could not finish this. Nothing was changed. Try again.'))
    await finishWorker(db, root, { status: stopped ? 'stopped' : 'failed' })
    options.emit?.({ event: 'custom', data: { type: 'answer', turn_id: turn.id } })
  } finally {
    clearInterval(timer)
  }
}
