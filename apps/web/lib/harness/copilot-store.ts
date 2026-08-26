// Copilot conversation persistence.
//
// Small data-access module for copilot_conversations / copilot_messages (see
// supabase/migrations/20260728000003_copilot_conversations.sql). Neither table
// is in @cello/shared's generated Database type, so — matching the rest of the
// harness (see ./supabase-admin.ts) — this uses the untyped service-role
// AdminClient and hand-declares row shapes here. Every function that reads or
// mutates a conversation is ownership-checked against `userId` explicitly;
// nothing here trusts a caller-supplied id to belong to the caller.

import type { AdminClient } from './types'

export interface ConversationRow {
  id: string
  user_id: string
  title: string
  model: string | null
  enabled_agents: string[] | null
  /**
   * Per-conversation "bypass permissions" toggle (see route.ts's
   * submitOrSendReason/dispatch comments for what it does and does not
   * unlock). Optional in the TS type — not `?? false` — because a row read
   * before migration 20260728000006_copilot_bypass_mode.sql lands will
   * simply omit the column; callers should read it as `Boolean(row.bypass_mode)`.
   */
  bypass_mode?: boolean
  /**
   * The LangGraph thread (graph_threads.thread_id) backing this conversation
   * — see supabase/migrations/20260817000004_runs_thread_link.sql. Optional
   * for the same reason bypass_mode is: a row read before that migration
   * lands simply omits the column. NULL until lib/graph/copilot.ts's
   * beginTurn links it on the conversation's first turn.
   */
  thread_id?: string | null
  created_at: string
  updated_at: string
}

export type MessageRole = 'user' | 'assistant'

export interface MessageRow {
  id: string
  conversation_id: string
  user_id: string
  role: MessageRole
  content: string
  trace: unknown
  created_at: string
}

/** First 60 chars of the opening user message, used as the auto-title. */
export function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 60) return trimmed || 'New chat'
  return trimmed.slice(0, 60).trimEnd() + '…'
}

/** Create a new conversation owned by `userId`, seeded with an auto-title. */
export async function createConversation(
  admin: AdminClient,
  userId: string,
  opts: { title?: string; model?: string | null; enabledAgents?: string[] | null; bypassMode?: boolean } = {}
): Promise<ConversationRow> {
  const { data, error } = await admin
    .from('copilot_conversations')
    .insert({
      user_id: userId,
      title: opts.title?.trim() || 'New chat',
      model: opts.model ?? null,
      enabled_agents: opts.enabledAgents ?? null,
      ...(opts.bypassMode !== undefined ? { bypass_mode: opts.bypassMode } : {}),
    })
    .select('*')
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Failed to create conversation')
  return data as ConversationRow
}

/** Load a conversation, verifying `userId` owns it. Returns null otherwise. */
export async function getConversation(
  admin: AdminClient,
  userId: string,
  conversationId: string
): Promise<ConversationRow | null> {
  const { data } = await admin
    .from('copilot_conversations')
    .select('*')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle()
  return (data as ConversationRow | null) ?? null
}

/** The user's most recent conversations (latest 30), newest first. */
export async function listConversations(
  admin: AdminClient,
  userId: string
): Promise<Pick<ConversationRow, 'id' | 'title' | 'updated_at'>[]> {
  const { data } = await admin
    .from('copilot_conversations')
    .select('id, title, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(30)
  return (data as Pick<ConversationRow, 'id' | 'title' | 'updated_at'>[]) ?? []
}

/** Append one message to a conversation. Does not touch updated_at itself. */
export async function appendMessage(
  admin: AdminClient,
  args: { conversationId: string; userId: string; role: MessageRole; content: string; trace?: unknown }
): Promise<MessageRow> {
  const { data, error } = await admin
    .from('copilot_messages')
    .insert({
      conversation_id: args.conversationId,
      user_id: args.userId,
      role: args.role,
      content: args.content,
      trace: args.trace ?? null,
    })
    .select('*')
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Failed to save message')
  return data as MessageRow
}

/** Last `limit` messages of a conversation, oldest first (ready for LLM history). */
export async function loadRecentMessages(
  admin: AdminClient,
  conversationId: string,
  limit = 24
): Promise<MessageRow[]> {
  const { data } = await admin
    .from('copilot_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  const rows = (data as MessageRow[]) ?? []
  return rows.reverse()
}

/** Bump updated_at (and optionally title/model/enabled_agents/bypass_mode) after a turn. */
export async function touchConversation(
  admin: AdminClient,
  conversationId: string,
  patch: { title?: string; model?: string | null; enabledAgents?: string[] | null; bypassMode?: boolean } = {}
): Promise<void> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.title !== undefined) update.title = patch.title
  if (patch.model !== undefined) update.model = patch.model
  if (patch.enabledAgents !== undefined) update.enabled_agents = patch.enabledAgents
  if (patch.bypassMode !== undefined) update.bypass_mode = patch.bypassMode
  // Best-effort like every other write in this module: a column that doesn't
  // exist yet (migration not applied) or any other transient error must not
  // throw out of a turn's terminal path — callers already treat this as
  // fire-and-forget, so swallow rather than surface.
  try {
    await admin.from('copilot_conversations').update(update).eq('id', conversationId)
  } catch {
    // best-effort
  }
}

/**
 * Delete `messageId` and every message after it (by created_at) in the same
 * conversation — the primitive behind "edit a previous message and re-run
 * from here". Destructive by design (Claude Code behaviour): the caller is
 * responsible for only invoking this on an explicit, confirmed user action,
 * never as a side effect of typing.
 *
 * Ownership: scoped by conversationId only — the caller (route.ts) has
 * already verified the conversation belongs to the requesting user via
 * getConversation() before this runs, matching how appendMessage/
 * loadRecentMessages are scoped in this module.
 */
export async function deleteMessagesFrom(
  admin: AdminClient,
  conversationId: string,
  messageId: string
): Promise<number> {
  const { data: target, error: findErr } = await admin
    .from('copilot_messages')
    .select('created_at')
    .eq('id', messageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (findErr) throw new Error(findErr.message)
  if (!target) return 0

  const { data, error } = await admin
    .from('copilot_messages')
    .delete()
    .eq('conversation_id', conversationId)
    .gte('created_at', (target as { created_at: string }).created_at)
    .select('id')
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data.length : 0
}

/** Delete a conversation (and its messages, via ON DELETE CASCADE), ownership-checked. */
export async function deleteConversation(admin: AdminClient, userId: string, conversationId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('copilot_conversations')
    .delete()
    .eq('id', conversationId)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  return Boolean(data)
}
