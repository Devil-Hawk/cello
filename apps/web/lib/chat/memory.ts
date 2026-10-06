// Memory across chats (directive 32). After each turn code writes three kinds of memory to the memory store:
//
//   chat.said     one per typed turn: the typed line, cut at 400 characters so the whole text fits the embedder
//   chat.made     one per thing the turn made: a code sentence from its row
//   chat.decided  one per decision taken in the turn (a Confirm, a start, a reaction, a saved answer)
//
// No model chooses what is kept or says it: every text below is code's rendering of a row. The store is
// written with infer false and no params, so these memories change no ranking, no writing and no setting;
// they serve recall only. mem0 is the index, the rows are the record (see recall.ts).

import type { AdminClient } from '@/lib/harness/types'
import type { MemoryStore } from '@/lib/memory/types'

export type ChatMemoryStore = MemoryStore

export const SAID_MAX = 400
export const CHAT_SCOPES = ['chat.said', 'chat.made', 'chat.decided'] as const
export type ChatScope = (typeof CHAT_SCOPES)[number]

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** True for a memory this module wrote, so a learning list can leave it out. */
export const isChatMemory = (item: { metadata?: Record<string, unknown> }) => CHAT_SCOPES.some((s) => s === item.metadata?.scope)

export const renderSaid = (typed: string) => {
  const line = typed.replace(/\s+/g, ' ').trim()
  return line.length > SAID_MAX ? `${line.slice(0, SAID_MAX - 1).trimEnd()}…` : line
}
export const renderMade = (made: { type: string; title: string; created_at: string }) => `Made ${made.type.replace(/_/g, ' ')}: ${made.title}. ${day(made.created_at)}.`
export const renderDecided = (d: { sentence: string; at: string }) => `Decided: ${d.sentence.replace(/\s+/g, ' ').trim()}. ${day(d.at)}.`

export interface TurnMemories {
  chatId: string
  /** The person's turn that started the exchange: what a made thing, a decision and the typed line all point at. */
  turnId: string
  /** The typed line. Left out when its memory is already written (a backfill that finds only a made thing missing). */
  typed?: string
  /** The names of the things attached at this turn, kept beside the typed line. */
  attached: string[]
  made: { id: string; type: string; title: string; created_at: string }[]
  decided: { sentence: string; at: string; eventId?: string }[]
}

/**
 * Writes the turn's memories. A failed write never fails the turn: the count says how many did not land.
 * A demo session writes none (the store refuses it).
 */
export async function writeTurnMemories(store: ChatMemoryStore, userId: string, turn: TurnMemories, isDemo = false): Promise<{ written: number; failed: number }> {
  if (isDemo) return { written: 0, failed: 0 }
  const where = { chat_id: turn.chatId, turn_id: turn.turnId }
  const writes: { fact: string; scope: ChatScope; refs: Record<string, unknown> }[] = [
    ...(turn.typed ? [{ fact: renderSaid(turn.typed), scope: 'chat.said' as const, refs: { ...where, attached: turn.attached, origin: 'person' } }] : []),
    ...turn.made.map((m) => ({ fact: renderMade(m), scope: 'chat.made' as const, refs: { ...where, table: 'artifacts', id: m.id, origin: 'code' } })),
    ...turn.decided.map((d) => ({ fact: renderDecided(d), scope: 'chat.decided' as const, refs: { ...where, ...(d.eventId ? { event_id: d.eventId } : {}), origin: 'code' } })),
  ]
  const results = await Promise.allSettled(writes.map((w) => store.add(userId, { fact: w.fact, scope: w.scope, refs: w.refs, isDemo: false })))
  const failed = results.filter((r) => r.status === 'rejected').length
  return { written: writes.length - failed, failed }
}

/** Deletes every chat memory of one chat. What the chat made stays on its own row. */
export async function deleteChatMemories(store: ChatMemoryStore, userId: string, chatId: string): Promise<number> {
  const mine = (await store.getAll(userId, { filters: { chat_id: chatId } })).filter(isChatMemory)
  await Promise.all(mine.map((m) => store.delete(userId, m.id)))
  return mine.length
}

/** Deletes a chat: its memories first, then the chat with its turns and tiles. What it made stays, unlinked. */
export async function deleteChat(db: AdminClient, store: ChatMemoryStore, userId: string, chatId: string): Promise<boolean> {
  const { data: chat } = await db.from('chats').select('id').eq('id', chatId).eq('user_id', userId).maybeSingle()
  if (!chat) return false
  await deleteChatMemories(store, userId, chatId)
  const { error } = await db.from('chats').delete().eq('id', chatId).eq('user_id', userId)
  return !error
}
