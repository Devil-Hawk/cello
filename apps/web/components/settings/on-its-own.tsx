'use client'

// What Cello does on its own: one row per built-in job, from job_heartbeats (the same rows as Chat's Scheduled).
// Last run, what it found, next run and Do it now. Plain words: no cron strings, no run ids.

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Key } from '@/components/ui/key'

interface Beat {
  job: string
  succeeded_at: string | null
  next_due_at: string | null
  found: Record<string, unknown> | null
  failure: string | null
}

const JOBS: { job: string; label: string; doIt?: string }[] = [
  { job: 'roles.check', label: 'Find new roles', doIt: '/api/jobs/refresh' },
  { job: 'inbox.sync', label: 'Read your mail', doIt: '/api/gmail/sync' },
  { job: 'network.sync', label: 'Find people in your mail' },
  { job: 'summary.send', label: 'Daily summary', doIt: '/api/digest/send' },
  { job: 'harness.learn', label: 'Learning' },
]

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null)

/** What the last run counted, as a short sentence; a failure is its class, never a message. */
function foundLine(b: Beat | undefined): string {
  if (!b) return 'Has not run yet.'
  if (b.failure) return 'The last run did not finish. Cello will try again.'
  const f = b.found ?? {}
  const parts = Object.entries(f)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
  return parts.length ? `Found ${parts.slice(0, 3).join(', ')}.` : 'Nothing new.'
}

export function OnItsOwn() {
  const [beats, setBeats] = useState<Record<string, Beat> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await createClient()
      .from('job_heartbeats')
      .select('job, succeeded_at, next_due_at, found, failure')
      .in('job', JOBS.map((j) => j.job))
    setBeats(Object.fromEntries(((data ?? []) as Beat[]).map((b) => [b.job, b])))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function run(job: string, path: string) {
    setBusy(job)
    setNote(null)
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      setNote(res.ok ? 'Started. It will show here when it finishes.' : 'Could not start that. Try again in a moment.')
      await load()
    } catch {
      setNote('Could not start that. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="own-heading" className="r-sheet p-6">
      <h2 id="own-heading" className="r-title">What Cello does on its own</h2>
      <ul className="mt-3 divide-y divide-[var(--r-line)]">
        {JOBS.map(({ job, label, doIt }) => {
          const b = beats?.[job]
          return (
            <li key={job} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 flex-1 basis-56">
                <p className="r-name">{label}</p>
                <p className="r-meta">
                  {beats === null ? 'Reading.' : `${foundLine(b)}${b?.succeeded_at ? ` Last ran ${when(b.succeeded_at)}.` : ''}${b?.next_due_at ? ` Next ${when(b.next_due_at)}.` : ''}`}
                </p>
              </div>
              {doIt && (
                <Key variant="raised" disabled={busy === job} onClick={() => run(job, doIt)}>
                  {busy === job ? 'Starting' : 'Do it now'}
                </Key>
              )}
            </li>
          )
        })}
      </ul>
      {note && <p className="r-meta mt-2" role="status">{note}</p>}
    </section>
  )
}
