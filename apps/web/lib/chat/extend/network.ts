// Network's additions to Chat: the follow-up candidate of chat.suggest and the screen-message hook that
// brings what Cello remembers about an employer or a person. Both are code over the person's own rows.
//
// The two types are declared here because ./index arrives with the chat lane; they are the same shapes.
// When chat merges, this file takes ours and the types import from './index' instead.
// ponytail: K24a's suggestCandidates is a static list, so a per-person candidate is `suggestFor`; chat adds
// `...(await network.suggestFor?.(db, userId, now) ?? [])` in lib/chat/suggest.ts.

import type { AdminClient } from '@/lib/harness/types'
import { recall } from '@/lib/network/memory'
import { dueNudges } from '@/lib/network/nudges'

export interface SuggestCandidate {
  kind: string
  text: string
  priority: number
  objects?: { kind: string; ref: string }[]
}
export type ScreenMessageHook = (db: AdminClient, userId: string, objects: { kind: string; ref: string }[]) => Promise<string[]>

export const suggestCandidates: SuggestCandidate[] = []

/** The oldest follow-up due on Network's rule, "Follow up with Marcus". */
export async function suggestFor(db: AdminClient, userId: string, now: Date): Promise<SuggestCandidate[]> {
  const [first] = await dueNudges(db as never, userId, now).catch(() => [])
  if (!first) return []
  const text = `Follow up with ${first.firstName}`
  return [{ kind: 'follow_up', text: text.slice(0, 40), priority: 60, objects: [{ kind: 'person', ref: first.contactId }] }]
}

const MAX_PER_EMPLOYER = 8

const memoriesFor: ScreenMessageHook = async (db, userId, objects) => {
  const lines: string[] = []
  for (const o of objects) {
    let by: { contactId?: string; employerId?: string } | null = null
    if (o.kind === 'person') by = { contactId: o.ref }
    else if (o.kind === 'company') {
      const { data } = await db.from('companies').select('employer_id').eq('id', o.ref).eq('user_id', userId).maybeSingle()
      const employerId = (data as { employer_id?: string | null } | null)?.employer_id
      if (employerId) by = { employerId }
    }
    if (!by) continue
    for (const m of await recall(db as never, userId, by, MAX_PER_EMPLOYER).catch(() => [])) {
      lines.push(`Memory (${m.kind.replace('person.', '')}): ${m.text} Quote: "${m.quote}"${m.stored ? '' : ' (the message is no longer stored)'}`)
    }
  }
  return lines
}

export const screenMessageHooks: ScreenMessageHook[] = [memoriesFor]
