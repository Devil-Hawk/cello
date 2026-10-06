// Reading and archiving a person's chats, and reading their earlier Copilot conversations.
// Every function takes the person's id and checks it on the row; nothing trusts an id from the caller.
// These are the bodies of chat.list, chat.get, chat.archive and chat.earlier once the registry is on main.

import { listConversations } from '@/lib/harness/copilot-store'
import type { AdminClient } from '@/lib/harness/types'
import type { AttachmentRow, ChatRow, TurnRow } from './types'

const CHAT_COLUMNS = 'id, user_id, title, created_at, last_turn_at, archived_at, project_id, pinned_at, model_choice, settings'

/**
 * The Recents list: pinned chats first, then the rest by their last turn, newest first.
 * Archived chats stay out unless asked for. `before` is the last_turn_at of the last row of the previous page.
 */
export async function listChats(
  db: AdminClient,
  userId: string,
  opts: { limit?: number; before?: string; archived?: boolean } = {}
): Promise<ChatRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)
  const own = () => {
    const q = db.from('chats').select(CHAT_COLUMNS).eq('user_id', userId)
    return opts.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  }
  // Two reads instead of one ordered by a nullable column: the pinned ones are few and always shown first.
  const pinned = opts.before
    ? []
    : (((await own().not('pinned_at', 'is', null).order('pinned_at', { ascending: false })).data as ChatRow[] | null) ?? [])
  let rest = own().is('pinned_at', null)
  if (opts.before) rest = rest.lt('last_turn_at', opts.before)
  const { data } = await rest.order('last_turn_at', { ascending: false }).limit(limit)
  return [...pinned, ...((data as ChatRow[] | null) ?? [])]
}

export interface ChatView {
  chat: ChatRow
  /** Every turn in order, superseded ones included: the page hides them behind "Version 1 of 2". */
  turns: TurnRow[]
  /** Every tile, detached ones included, so an older answer still shows the tile it was about. */
  attachments: AttachmentRow[]
}

/** One chat with its turns and tiles. Null when it is not this person's. */
export async function getChat(db: AdminClient, userId: string, chatId: string): Promise<ChatView | null> {
  const { data: chat } = await db.from('chats').select(CHAT_COLUMNS).eq('id', chatId).eq('user_id', userId).maybeSingle()
  if (!chat) return null
  const [turns, attachments] = await Promise.all([
    db
      .from('chat_turns')
      .select('id, user_id, chat_id, kind, typed, answer, origin, parts, links, quoted, created_at')
      .eq('chat_id', chatId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true }),
    db
      .from('chat_attachments')
      .select('id, user_id, chat_id, position, kind, ref, origin, prov, added_at, removed_at')
      .eq('chat_id', chatId)
      .eq('user_id', userId)
      .order('position', { ascending: true }),
  ])
  return {
    chat: chat as ChatRow,
    turns: (turns.data as TurnRow[] | null) ?? [],
    attachments: (attachments.data as AttachmentRow[] | null) ?? [],
  }
}

/** Archives a chat (or brings it back). It stays readable and recallable. False when it is not this person's. */
export async function archiveChat(db: AdminClient, userId: string, chatId: string, archived = true): Promise<boolean> {
  const { data } = await db
    .from('chats')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', chatId)
    .eq('user_id', userId)
    .select('id')
  return ((data as unknown[] | null) ?? []).length === 1
}

/** chat.pin: a pinned chat goes first in Recents. */
export async function pinChat(db: AdminClient, userId: string, chatId: string, pinned = true): Promise<boolean> {
  const { data } = await db.from('chats').update({ pinned_at: pinned ? new Date().toISOString() : null }).eq('id', chatId).eq('user_id', userId).select('id')
  return ((data as unknown[] | null) ?? []).length === 1
}

/** chat.rename: the person's own title, trimmed to 80 characters. An empty title is refused. */
export async function renameChat(db: AdminClient, userId: string, chatId: string, title: string): Promise<boolean> {
  const next = title.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!next) return false
  const { data } = await db.from('chats').update({ title: next }).eq('id', chatId).eq('user_id', userId).select('id')
  return ((data as unknown[] | null) ?? []).length === 1
}

export interface MadeRow {
  id: string
  type: string
  title: string
  current_version: number
  updated_at: string
  chat_turn_id: string | null
}

const MADE_COLUMNS = 'id, type, title, current_version, updated_at, chat_turn_id'

/**
 * chat.made: what Cello made for the person, whichever door made it, newest first. For the side panel and for an
 * application's record. `applicationId` narrows it to that application's (its project, or its role); `chatId` to
 * what that chat's turns made. A page of up to 100; `before` is the updated_at of the last row of the page before.
 */
export async function listMade(
  db: AdminClient,
  userId: string,
  opts: { applicationId?: string; chatId?: string; limit?: number; before?: string } = {}
): Promise<MadeRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)
  let q = db.from('artifacts').select(MADE_COLUMNS).eq('user_id', userId)
  if (opts.applicationId) {
    const { data: app } = await db.from('applications').select('job_id').eq('id', opts.applicationId).eq('user_id', userId).maybeSingle()
    if (!app) return []
    const { data: project } = await db.from('projects').select('id').eq('application_id', opts.applicationId).eq('user_id', userId).maybeSingle()
    const jobId = (app as { job_id: string }).job_id
    q = q.or(project ? `project_id.eq.${(project as { id: string }).id},job_id.eq.${jobId}` : `job_id.eq.${jobId}`)
  }
  if (opts.chatId) {
    const { data: turns } = await db.from('chat_turns').select('id').eq('chat_id', opts.chatId).eq('user_id', userId).eq('kind', 'person')
    const ids = ((turns as { id: string }[] | null) ?? []).map((t) => t.id)
    if (ids.length === 0) return []
    // A chat's turns are bounded by what a person types; the cap keeps the filter short.
    q = q.in('chat_turn_id', ids.slice(0, 200))
  }
  if (opts.before) q = q.lt('updated_at', opts.before)
  const { data } = await q.order('updated_at', { ascending: false }).limit(limit)
  return (data as MadeRow[] | null) ?? []
}

/**
 * Earlier: the person's old Copilot conversations, newest first. Read only: this module has no write to them.
 * ponytail: the latest 30, which is all the old page ever listed; page it if anyone has more worth finding.
 */
export const earlier = listConversations
