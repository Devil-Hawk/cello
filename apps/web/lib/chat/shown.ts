// Chat ships hidden. It shows for the account that runs the deployment (OWNER_USER_ID) and, once the owner turns
// the switch on, for everyone: the owner does that only after S13, S14, S15 and S21 pass on the scorecard.
// ponytail: a switch the owner flips; read measure_runs per request if he wants it automatic.

import type { AdminClient } from '@/lib/harness/types'
import { isOpsOwner } from '@/lib/quality/ops-owner'

// A missing table or row reads as off: hidden is the safe answer.
const flagOn = async (db: AdminClient, key: string) => {
  const { data } = await db.from('instance_flags').select('on').eq('key', key).maybeSingle()
  return (data as { on: boolean } | null)?.on === true
}

export async function chatOpen(db: AdminClient, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false
  return isOpsOwner(userId) || flagOn(db, 'chat_shown')
}

/**
 * Recall from earlier chats in words ("the six I compared yesterday") is shown once S22 passes: the owner turns
 * chat_recall_words on then. Until it does, attaching an earlier chat works and nothing is recalled by itself.
 */
export const recallInWordsOn = (db: AdminClient) => flagOn(db, 'chat_recall_words')
