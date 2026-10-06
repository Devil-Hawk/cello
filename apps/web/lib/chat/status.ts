// A status turn says what happened to an application the chat holds. The turn row only names the pipeline event
// (the database trigger writes it, migration 20261024300002); the words are read here, from that event's own row, so a
// model, an email subject or a posting cannot put a sentence in the chat.
// Until the pipeline's table exists the read finds nothing and the turn shows no line.

import type { AdminClient } from '@/lib/harness/types'

export interface StatusLine {
  /** The pipeline event this line reports. */
  eventId: string
  /** Plain words from the event, at most 280 characters (the pipeline's own rule). */
  sentence: string
  applicationId: string
  /** Where the application stands after the event. */
  state: string | null
  at: string
}

/** The lines for these events, this person's only. An event that is not theirs or no longer exists has no line. */
export async function readStatusLines(db: AdminClient, userId: string, eventIds: string[]): Promise<Record<string, StatusLine>> {
  const ids = [...new Set(eventIds)].slice(0, 200)
  if (ids.length === 0) return {}
  const { data } = await db.from('pipeline_events').select('id, application_id, sentence, to_state, created_at').eq('user_id', userId).in('id', ids)
  const rows = (data as { id: string; application_id: string | null; sentence: string | null; to_state: string | null; created_at: string }[] | null) ?? []
  return Object.fromEntries(
    rows.flatMap((r) => (r.application_id && r.sentence ? [[r.id, { eventId: r.id, sentence: r.sentence.slice(0, 280), applicationId: r.application_id, state: r.to_state, at: r.created_at } satisfies StatusLine] as const] : []))
  )
}
