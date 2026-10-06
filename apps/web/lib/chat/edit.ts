// chat.edit_turn, the stored half: editing the person's earlier turn forks the chat from there. The old turn and
// every turn after it stay, marked superseded, and the page shows them behind "Version 1 of 2". The new turn
// carries `branch_of` and the engine resumes from the checkpoint the old turn ran from. Anything the old branch
// started or drafted stays, with its Undo: nothing here touches made things or applications.

import type { AdminClient } from '@/lib/harness/types'
import type { Refusal } from './types'

export interface ForkedTurn {
  id: string
  /** The checkpoint the old turn ran from, for the engine to resume at. Null when it was pruned: the engine then rebuilds from rows. */
  checkpointId: string | null
}

export async function forkFromTurn(db: AdminClient, userId: string, chatId: string, turnId: string, typed: string): Promise<({ ok: true } & ForkedTurn) | Refusal> {
  const words = typed.trim()
  if (!words) return { ok: false, error: 'There is nothing to send.', fix: 'Type the new words for this turn.' }
  const { data } = await db.from('chat_turns').select('id, kind, created_at, superseded_at, ran').eq('id', turnId).eq('chat_id', chatId).eq('user_id', userId).maybeSingle()
  const turn = data as { id: string; kind: string; created_at: string; superseded_at: string | null; ran: { checkpoint_id?: string } | null } | null
  if (!turn || turn.kind !== 'person' || turn.superseded_at) return { ok: false, error: 'That turn cannot be edited.', fix: 'Edit one of your own earlier messages.' }

  // The new turn goes in first: if it fails, the old turn is untouched and can be edited again.
  const { data: made, error } = await db.from('chat_turns').insert({ user_id: userId, chat_id: chatId, kind: 'person', typed: words, origin: 'person', branch_of: turn.id }).select('id').single()
  if (error || !made) return { ok: false, error: 'Could not start the edited turn.', fix: 'Try again.' }
  const id = (made as { id: string }).id
  const { error: hid } = await db.from('chat_turns').update({ superseded_at: new Date().toISOString() }).eq('chat_id', chatId).eq('user_id', userId).gte('created_at', turn.created_at).neq('id', id).is('superseded_at', null)
  if (hid) {
    await db.from('chat_turns').delete().eq('id', id).eq('user_id', userId)
    return { ok: false, error: 'Could not start the edited turn.', fix: 'Try again.' }
  }
  return { ok: true, id, checkpointId: turn.ran?.checkpoint_id ?? null }
}
