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

/**
 * Earlier: the person's old Copilot conversations, newest first. Read only: this module has no write to them.
 * ponytail: the latest 30, which is all the old page ever listed; page it if anyone has more worth finding.
 */
export const earlier = listConversations
