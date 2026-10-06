// chat.recall: find what an earlier chat said, made or decided, for the person asking and no one else.
//
// Meaning first: the memory store's search (the person's own memories only). When the embedder is down, words:
// one query over what they typed, what they titled a chat and what a made thing is called. Either way the store
// and the query are only an index. Every hit is read from its row before it is returned, so a deleted chat or
// made thing drops out, the text shown is the row's and not the memory's, and each hit names its source chat and turn.

import type { AdminClient } from '@/lib/harness/types'
import { isChatMemory, type ChatMemoryStore } from './memory'
import type { TurnLink } from './types'

/**
 * Hits scoring below this are not recalled. ponytail: a starting value; S22's ten pairs set the real floor,
 * and recall in words stays off until S22 passes.
 */
export const SIMILARITY_FLOOR = 0.35

export interface RecallHit {
  kind: 'said' | 'made' | 'decided' | 'chat'
  /** From the row: the typed line, the made thing's title, the chat's title; the decision's sentence. */
  text: string
  chat: { id: string; title: string } | null
  turnId: string | null
  made: { id: string; type: string } | null
  /** The recalled link the turn stores and the part's source line follows. */
  link: TurnLink
}

interface Candidate {
  kind: RecallHit['kind']
  chatId: string | null
  turnId: string | null
  artifactId: string | null
  /** The decision's own sentence: a decision has no row of its own to read it from. */
  sentence?: string
}

type Row = Record<string, unknown>

async function one(db: AdminClient, table: string, columns: string, userId: string, id: string): Promise<Row | null> {
  const { data } = await db.from(table).select(columns).eq('id', id).eq('user_id', userId).maybeSingle()
  return (data as Row | null) ?? null
}

/** Reads the row behind a candidate; null when it is gone or is not this person's. */
async function hydrate(db: AdminClient, userId: string, c: Candidate): Promise<RecallHit | null> {
  const turn = c.turnId ? await one(db, 'chat_turns', 'id, chat_id, typed', userId, c.turnId) : null
  const chatId = (turn?.chat_id as string | undefined) ?? c.chatId
  const chat = chatId ? await one(db, 'chats', 'id, title', userId, chatId) : null
  const where = chat ? { chat_id: chat.id as string, turn_id: (turn?.id as string | undefined) ?? '' } : undefined

  if (c.kind === 'made') {
    const made = c.artifactId ? await one(db, 'artifacts', 'id, type, title', userId, c.artifactId) : null
    if (!made) return null
    return {
      kind: 'made',
      text: String(made.title),
      chat: chat ? { id: chat.id as string, title: String(chat.title) } : null,
      turnId: (turn?.id as string | undefined) ?? null,
      made: { id: made.id as string, type: String(made.type) },
      link: { kind: 'made', table: 'artifacts', id: made.id as string, role: 'recalled', ...(where ? { source: where } : {}) },
    }
  }
  if (!chat) return null
  const base = { chat: { id: chat.id as string, title: String(chat.title) }, made: null }
  if (c.kind === 'chat') return { ...base, kind: 'chat', text: String(chat.title), turnId: null, link: { kind: 'chat', table: 'chats', id: chat.id as string, role: 'recalled' } }
  // said and decided both rest on a turn that must still exist.
  if (!turn) return null
  return {
    ...base,
    kind: c.kind,
    text: c.kind === 'said' ? String(turn.typed ?? '') : (c.sentence ?? ''),
    turnId: turn.id as string,
    link: { kind: 'chat', table: 'chats', id: chat.id as string, role: 'recalled', source: { chat_id: chat.id as string, turn_id: turn.id as string } },
  }
}

const WORDS = /\w{3,}/g

/** Meaning first; words when the store cannot search. */
async function candidates(db: AdminClient, store: ChatMemoryStore, userId: string, query: string, limit: number, floor: number): Promise<Candidate[]> {
  try {
    const found = await store.search(userId, query, { limit: limit * 3 })
    return found
      .filter((m) => isChatMemory(m) && (m.score === undefined || m.score >= floor))
      .map((m): Candidate => ({
        kind: m.metadata?.scope === 'chat.said' ? 'said' : m.metadata?.scope === 'chat.made' ? 'made' : 'decided',
        chatId: (m.metadata?.chat_id as string | undefined) ?? null,
        turnId: (m.metadata?.turn_id as string | undefined) ?? null,
        artifactId: m.metadata?.scope === 'chat.made' ? ((m.metadata?.id as string | undefined) ?? null) : null,
        sentence: m.memory,
      }))
  } catch {
    const terms = [...new Set(query.toLowerCase().match(WORDS) ?? [])].slice(0, 8)
    if (terms.length === 0) return []
    const { data } = await db.rpc('chat_recall_words', { p_user: userId, p_query: terms.join(' or '), p_limit: limit })
    return ((data as { kind: string; chat_id: string | null; turn_id: string | null; artifact_id: string | null }[] | null) ?? []).map((r): Candidate => ({
      kind: r.kind === 'turn' ? 'said' : r.kind === 'chat' ? 'chat' : 'made',
      chatId: r.chat_id,
      turnId: r.turn_id,
      artifactId: r.artifact_id,
    }))
  }
}

/** Up to `limit` hits, best first, each read from its row. Another person's memories are never searched or read. */
export async function recall(
  db: AdminClient,
  store: ChatMemoryStore,
  userId: string,
  query: string,
  opts: { limit?: number; floor?: number } = {}
): Promise<RecallHit[]> {
  const limit = opts.limit ?? 5
  const found = await candidates(db, store, userId, query, limit, opts.floor ?? SIMILARITY_FLOOR)
  const hits: RecallHit[] = []
  const seen = new Set<string>()
  for (const c of found) {
    const hit = await hydrate(db, userId, c)
    const key = hit && `${hit.kind}:${hit.made?.id ?? hit.turnId ?? hit.chat?.id}`
    if (!hit || !key || seen.has(key)) continue
    seen.add(key)
    hits.push(hit)
    if (hits.length === limit) break
  }
  return hits
}
