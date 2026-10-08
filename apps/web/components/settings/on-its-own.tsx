'use client'

// What Cello does on its own: one row per built-in job, from job_heartbeats (the same rows as Chat's Scheduled).
// Last run, what it found, next run, the cost when the ledger recorded one, and Do it now. Plain words: no cron
// strings, no run ids, and no key of a job's own bookkeeping (a cursor, a carry) is ever printed as a number.

import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { Key } from '@/components/ui/key'
import type { ActivityRow } from '@/components/settings/activity-list'

export interface Beat {
  job: string
  succeeded_at: string | null
  next_due_at: string | null
  found: Record<string, unknown> | null
  failure: string | null
}

interface Job {
  job: string
  label: string
  /** The route that does it now, and the body it takes. */
  doIt?: { path: string; body: Record<string, unknown>; label?: string }
}

export const JOBS: Job[] = [
  { job: 'roles.check', label: 'Find new roles', doIt: { path: '/api/jobs/refresh', body: {} } },
  { job: 'roles.pick', label: "Pick today's roles", doIt: { path: '/api/shortlist', body: { refresh: true } } },
  { job: 'inbox.sync', label: 'Read your mail', doIt: { path: '/api/gmail/sync', body: {} } },
  { job: 'network.sync', label: 'Find people in your mail' },
  { job: 'summary.send', label: 'Daily summary', doIt: { path: '/api/digest/send', body: { force: true }, label: 'Send it now' } },
  { job: 'harness.learn', label: 'Learning' },
]

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

const SUMMARY_OUTCOME: Record<string, string> = {
  sent: 'Sent to your own inbox.',
  empty: 'Nothing to say, so nothing was sent.',
  off: 'Switched off.',
  demo: 'Demos do not send mail.',
  duplicate: 'Already sent today.',
  too_soon: 'Already sent within the hour.',
  no_scope: 'Needs the permission to send from your Gmail.',
  failed: 'Could not send.',
  held: 'Held for quiet hours.',
}

/**
 * What one job's last run counted, as a short sentence. Each job names the keys it reports; anything else in the
 * heartbeat (a cursor, a carry, a note) is the job's own bookkeeping and is never shown. A failure is its class,
 * never a message.
 */
export function foundLine(job: string, b: Beat | undefined): string {
  if (!b) return 'Has not run yet.'
  if (b.failure) return 'The last run did not finish. Cello will try again.'
  const f = b.found ?? {}
  const parts: string[] = []
  switch (job) {
    case 'roles.check':
      if (n(f.read) > 0) parts.push(`Read ${plural(n(f.read), 'employer', 'employers')}.`)
      if (n(f.new) > 0) parts.push(`${plural(n(f.new), 'new role', 'new roles')}${n(f.matched) > 0 ? `, ${n(f.matched)} kept for you` : ''}.`)
      if (n(f.cannot_read) > 0) parts.push(`Could not read ${plural(n(f.cannot_read), 'employer', 'employers')}.`)
      break
    case 'roles.pick':
      if (n(f.picked) > 0) parts.push(`Picked ${plural(n(f.picked), 'role', 'roles')}.`)
      break
    case 'inbox.sync':
      if (n(f.read) > 0) parts.push(`Read ${plural(n(f.read), 'message', 'messages')}.`)
      if (n(f.applications) > 0) parts.push(`${plural(n(f.applications), 'application', 'applications')} found.`)
      break
    case 'network.sync':
      if (n(f.people) > 0) parts.push(`${plural(n(f.people), 'person', 'people')} found so far.`)
      break
    case 'summary.send':
      if (typeof f.outcome === 'string' && SUMMARY_OUTCOME[f.outcome]) parts.push(SUMMARY_OUTCOME[f.outcome])
      break
    case 'harness.learn':
      if (n(f.counted) > 0) parts.push(`Counted ${plural(n(f.counted), 'thing', 'things')} from your record.`)
      break
  }
  return parts.length ? parts.join(' ') : 'Nothing new.'
}

/** This week's cost of a job's own work, when the ledger recorded any. */
export function costOf(job: string, rows: ActivityRow[]): number {
  return rows.filter((r) => r.step === job || r.step.startsWith(`${job}.`)).reduce((s, r) => s + r.usd, 0)
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null)

export function JobRow({ job, beat, cost, loading, busy, onRun }: { job: Job; beat: Beat | undefined; cost: number; loading: boolean; busy: boolean; onRun: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <p className="r-name">{job.label}</p>
        <p className="r-meta">
          {loading ? 'Reading.' : `${foundLine(job.job, beat)}${beat?.succeeded_at ? ` Last ran ${when(beat.succeeded_at)}.` : ''}${beat?.next_due_at ? ` Next ${when(beat.next_due_at)}.` : ''}${cost > 0 ? ` $${cost.toFixed(2)} this week.` : ''}`}
        </p>
      </div>
      {job.doIt && (
        <Key variant="raised" disabled={busy} onClick={onRun}>
          {busy ? 'Starting' : (job.doIt.label ?? 'Do it now')}
        </Key>
      )}
    </li>
  )
}

export function OnItsOwn() {
  const [beats, setBeats] = useState<Record<string, Beat> | null>(null)
  const [costs, setCosts] = useState<ActivityRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    // job_heartbeats is newer than the generated types
    const { data } = await (createClient() as unknown as SupabaseClient)
      .from('job_heartbeats')
      .select('job, succeeded_at, next_due_at, found, failure')
      .in('job', JOBS.map((j) => j.job))
    setBeats(Object.fromEntries(((data ?? []) as Beat[]).map((b) => [b.job, b])))
  }, [])

  useEffect(() => {
    void load()
    fetch('/api/settings/activity?days=7')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { rows?: ActivityRow[] } | null) => setCosts(d?.rows ?? []))
      .catch(() => undefined)
  }, [load])

  async function run(job: Job) {
    if (!job.doIt) return
    setBusy(job.job)
    setNote(null)
    try {
      const res = await fetch(job.doIt.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.doIt.body) })
      setNote(res.ok ? 'Started. It will show here when it finishes.' : 'Could not start that. Try again in a moment.')
      await load()
    } catch {
      setNote('Could not start that. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section id="on-its-own" aria-labelledby="own-heading" className="r-sheet scroll-mt-6 p-6">
      <h2 id="own-heading" className="r-title">What Cello does on its own</h2>
      <ul className="mt-3 divide-y divide-[var(--r-line)]">
        {JOBS.map((j) => (
          <JobRow key={j.job} job={j} beat={beats?.[j.job]} cost={costOf(j.job, costs)} loading={beats === null} busy={busy === j.job} onRun={() => run(j)} />
        ))}
      </ul>
      {note && <p className="r-meta mt-2" role="status">{note}</p>}
    </section>
  )
}
