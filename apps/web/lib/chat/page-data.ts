// Everything the Chat page reads for one chat, in one call: the chat, its turns and tiles, a name for each tile, the
// card of each subject an answer named, and the workers of its turns. Names and cards are read from the stored rows
// under the person's rights each time; nothing here is taken from a model's text. After a reload the page rebuilds
// its tasks line from these rows.

import type { AdminClient } from '@/lib/harness/types'
import { readCard, type Card } from './cards'
import { getObject } from './objects'
import { readStatusLines, type StatusLine } from './status'
import { getChat, type ChatView } from './store'
import { objectName, type ObjectReader } from './types'

export interface WorkerRow {
  id: string
  turn_id: string | null
  title: string
  status: string
  command: string | null
  reads: unknown[] | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface ChatPageData extends ChatView {
  /** Attachment id to the thing's name, or null when it is no longer listed. */
  names: Record<string, string | null>
  cards: Card[]
  tasks: WorkerRow[]
  /** Event id to the line a status turn shows, read from the event row. */
  statuses: Record<string, StatusLine>
  /** Made thing id to what its block under an answer shows, read from the row. */
  made: Record<string, MadeInfo>
  /** `kind:id` of a thing recalled from an earlier chat to the chat it came from, for the source line. */
  recalled: Record<string, { chatId: string; title: string; at: string }>
}

export interface MadeInfo {
  id: string
  type: string
  title: string
  version: number
  preview: string
}

export async function loadChatPage(db: AdminClient, userId: string, chatId: string, get: ObjectReader = getObject): Promise<ChatPageData | null> {
  const view = await getChat(db, userId, chatId)
  if (!view) return null
  const subjects = new Map<string, { kind: 'role' | 'company'; ref: string }>()
  for (const turn of view.turns) {
    for (const part of turn.parts ?? []) {
      if ('card' in part && (part.card.kind === 'role' || part.card.kind === 'company')) subjects.set(`${part.card.kind}:${part.card.ref}`, { kind: part.card.kind, ref: part.card.ref })
    }
  }
  const [named, cards, workers, statuses] = await Promise.all([
    Promise.all(view.attachments.map(async (a) => [a.id, objectName((await get(db, userId, a.kind, a.ref)) ?? { kind: a.kind, title: '', company: null }) || null] as const)),
    Promise.all([...subjects.values()].map((s) => readCard(db, userId, s))),
    db.from('agent_tasks').select('id, turn_id, title, status, command, reads, created_at, started_at, finished_at').eq('chat_id', chatId).eq('user_id', userId).order('created_at', { ascending: true }),
    readStatusLines(db, userId, view.turns.flatMap((t) => (t.kind === 'status' && t.event_id ? [t.event_id] : []))),
  ])
  const links = view.turns.flatMap((t) => t.links ?? [])
  const madeIds = [...new Set(links.filter((l) => l.kind === 'made' && l.role !== 'recalled').map((l) => l.id))].slice(0, 100)
  const sources = [...new Set(links.flatMap((l) => (l.role === 'recalled' && l.source ? [l.source.chat_id] : [])))].slice(0, 50)
  const [artifacts, earlier] = await Promise.all([
    madeIds.length ? db.from('artifacts').select('id, type, title, current_version').eq('user_id', userId).in('id', madeIds.slice(0, 100)) : null,
    sources.length ? db.from('chats').select('id, title, created_at').eq('user_id', userId).in('id', sources.slice(0, 50)) : null,
  ])
  const madeRows = (artifacts?.data as { id: string; type: string; title: string; current_version: number }[] | null) ?? []
  const madeKeys = madeRows.map((m) => m.id)
  const texts = madeRows.length ? (((await db.from('artifact_versions').select('artifact_id, version, content_text').in('artifact_id', madeKeys.slice(0, 100))).data as { artifact_id: string; version: number; content_text: string }[] | null) ?? []) : []
  const made: Record<string, MadeInfo> = Object.fromEntries(
    madeRows.map((m) => [m.id, { id: m.id, type: m.type, title: m.title, version: m.current_version, preview: (texts.find((v) => v.artifact_id === m.id && v.version === m.current_version)?.content_text ?? '').slice(0, 400) }])
  )
  const chats = new Map(((earlier?.data as { id: string; title: string; created_at: string }[] | null) ?? []).map((c) => [c.id, c]))
  const recalled: ChatPageData['recalled'] = {}
  for (const l of links) {
    const c = l.role === 'recalled' && l.source ? chats.get(l.source.chat_id) : undefined
    if (c) recalled[`${l.kind}:${l.id}`] = { chatId: c.id, title: c.title, at: c.created_at }
  }
  return {
    ...view,
    made,
    recalled,
    names: Object.fromEntries(named),
    cards: cards.filter((c): c is Card => c !== null),
    tasks: (workers.data as WorkerRow[] | null) ?? [],
    statuses,
  }
}
