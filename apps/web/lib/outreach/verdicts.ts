// The quality-check verdicts already stored for outreach drafts, shaped for the
// queue card. The draft route and the manual "Check this draft" both write them
// to eval_verdicts; until now nothing read them back, so the card offered a
// second paid check for a result the user had already paid for.

import type { AdminClient } from '@/lib/harness/types'
import type { OutreachMessageRow } from './types'

export interface StoredOutreachVerdict {
  judge: 'factuality' | 'closed_qa'
  verdict: string
  score: number | null
  rationale: string | null
}

/** The most messages one lookup covers (the list route's own maximum page). */
const MAX_MESSAGES = 200

type VerdictRow = StoredOutreachVerdict & { subject_id: string; created_at: string }

/**
 * The latest verdict per judge for each message, in one query. A verdict older
 * than the message's last edit describes text that no longer exists, so it is
 * dropped rather than shown against the wrong draft. Best-effort: a failed read
 * means no verdicts are shown, never that the list fails.
 */
export async function readStoredVerdicts(
  admin: AdminClient,
  userId: string,
  messages: Pick<OutreachMessageRow, 'id' | 'updated_at'>[]
): Promise<Map<string, StoredOutreachVerdict[]>> {
  const out = new Map<string, StoredOutreachVerdict[]>()
  if (messages.length === 0) return out
  const { data, error } = await admin
    .from('eval_verdicts')
    .select('subject_id, judge, verdict, score, rationale, created_at')
    .eq('user_id', userId)
    .eq('subject_kind', 'outreach_draft')
    .in('judge', ['factuality', 'closed_qa'])
    // Hard cap in the call itself: the list route never asks for more than 200.
    .in(
      'subject_id',
      messages.slice(0, MAX_MESSAGES).map((m) => m.id)
    )
    .order('created_at', { ascending: false })
  if (error) return out

  const updatedAt = new Map(messages.map((m) => [m.id, m.updated_at]))
  for (const v of (data ?? []) as VerdictRow[]) {
    const edited = updatedAt.get(v.subject_id)
    if (edited && Date.parse(v.created_at) < Date.parse(edited)) continue
    const list = out.get(v.subject_id) ?? []
    if (list.some((x) => x.judge === v.judge)) continue // rows arrive newest first
    list.push({ judge: v.judge, verdict: v.verdict, score: v.score, rationale: v.rationale })
    out.set(v.subject_id, list)
  }
  return out
}
