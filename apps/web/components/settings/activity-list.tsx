'use client'

// Activity (blueprint 4.12): the last week's model requests by the work they did and the door they came through,
// from the spend ledger through activity.get. Counts and cost as recorded, nothing estimated here.

import { useEffect, useState } from 'react'
import { DOOR_NAME, type Ceiling } from '@/components/settings/models-section'

export interface ActivityRow {
  step: string
  door: string
  rung: string
  count: number
  usd: number
}

const WHO: Record<string, string> = { session: 'You', chat: 'Chat', routine: 'Scheduled work', rule: 'Your rule', assistant: 'Your assistant', agent: 'Another agent', extension: 'Extension' }

const label = (s: string) => {
  const t = s.replace(/[._]/g, ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** One line per row: the work, how many requests, the door and the cost when there was one. Pure. */
export function activityLine(r: ActivityRow): string {
  const rung = DOOR_NAME[r.rung as Ceiling] ?? 'Another door'
  const cost = r.usd > 0 ? `, $${r.usd.toFixed(2)}` : ''
  return `${label(r.step)}: ${r.count} ${r.count === 1 ? 'request' : 'requests'} from ${WHO[r.door] ?? 'Cello'}, on ${rung.toLowerCase()}${cost}`
}

export function ActivityRows({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) return <p className="r-body">Nothing in the last 7 days.</p>
  return (
    <ul className="divide-y divide-[var(--r-line)]">
      {rows.map((r) => (
        <li key={`${r.step}|${r.door}|${r.rung}`} className="r-body py-2">{activityLine(r)}</li>
      ))}
    </ul>
  )
}

export function ActivityList() {
  const [rows, setRows] = useState<ActivityRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    fetch('/api/settings/activity?days=7')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { rows: ActivityRow[] }) => setRows(d.rows))
      .catch(() => setFailed(true))
  }, [])
  if (failed) return <p className="r-body" role="alert">Could not read your activity. Try again in a moment.</p>
  if (!rows) return <p className="r-meta">Reading.</p>
  return <ActivityRows rows={rows} />
}
