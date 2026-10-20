import type { WorkerRow } from '@/lib/chat/page-data'

type Row = Pick<WorkerRow, 'command' | 'status' | 'created_at' | 'started_at' | 'finished_at'>

/**
 * Seconds of work in a turn's rows. The plan card is the person deciding, not work: when the plan is answered
 * (done), the count starts at that answer, so the wait for it is left out. A turn with no answered plan counts from its earliest row.
 */
export function workedSeconds(rows: Row[], now = Date.now()): number {
  const answered = rows.find((r) => r.command === 'chat.plan' && r.status === 'done' && r.finished_at)
  const answeredAt = answered?.finished_at ? Date.parse(answered.finished_at) : NaN
  const starts = Number.isNaN(answeredAt)
    ? rows.map((r) => Date.parse(r.started_at ?? r.created_at)).filter((n) => !Number.isNaN(n))
    : [answeredAt]
  const ends = rows.map((r) => (r.finished_at ? Date.parse(r.finished_at) : now))
  return starts.length ? Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000)) : 0
}
