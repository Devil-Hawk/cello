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
  /** The tailored resume this line asks the person to approve, while the application still waits on it. */
  approval: { artifactId: string; version: number; hash: string } | null
}

/** The lines for these events, this person's only. An event that is not theirs or no longer exists has no line. */
export async function readStatusLines(db: AdminClient, userId: string, eventIds: string[]): Promise<Record<string, StatusLine>> {
  const ids = [...new Set(eventIds)].slice(0, 200)
  if (ids.length === 0) return {}
  const { data } = await db.from('pipeline_events').select('id, application_id, kind, sentence, to_state, payload, created_at').eq('user_id', userId).in('id', ids.slice(0, 200))
  const rows = (data as { id: string; application_id: string | null; kind: string; sentence: string | null; to_state: string | null; payload: Record<string, unknown> | null; created_at: string }[] | null) ?? []
  // An approval can be given only while the application still waits on it (the SQL refuses it otherwise).
  const appIds = [...new Set(rows.filter((r) => r.kind === 'approval.requested' && r.application_id).map((r) => r.application_id as string))]
  const waiting = new Set(
    appIds.length ? (((await db.from('applications').select('id').eq('user_id', userId).in('id', appIds.slice(0, 200)).eq('state', 'needs_you').eq('needs_reason', 'approve_resume')).data as { id: string }[] | null) ?? []).map((a) => a.id) : []
  )
  const approvalOf = (r: (typeof rows)[number]): StatusLine['approval'] => {
    const p = r.payload ?? {}
    return r.kind === 'approval.requested' && r.application_id && waiting.has(r.application_id) && typeof p.hash === 'string' && typeof p.artifact_id === 'string' && typeof p.version === 'number' ? { artifactId: p.artifact_id, version: p.version, hash: p.hash } : null
  }
  return Object.fromEntries(
    rows.flatMap((r) => (r.application_id && r.sentence ? [[r.id, { eventId: r.id, sentence: r.sentence.slice(0, 280), applicationId: r.application_id, state: r.to_state, at: r.created_at, approval: approvalOf(r) } satisfies StatusLine] as const] : []))
  )
}
