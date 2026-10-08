'use client'

// Your own instructions: the person's scheduled instructions, each with Run now, Pause and its last result.
// ponytail: reads /api/scheduled-tasks until K27 moves them to routines; the routes stay the same.

import { useCallback, useEffect, useState } from 'react'
import { Key } from '@/components/ui/key'

interface Task {
  id: string
  name: string
  status: 'active' | 'paused'
  card: { schedule: string; last: string | null; next: string | null }
}

export function Instructions() {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [off, setOff] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/scheduled-tasks')
    if (res.status === 404) return setOff(true)
    if (res.ok) setTasks(((await res.json()) as { tasks: Task[] }).tasks)
    else setNote('Could not read your instructions.')
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function act(t: Task, what: 'run' | 'toggle') {
    setNote(null)
    const res =
      what === 'run'
        ? await fetch(`/api/scheduled-tasks/${t.id}/run`, { method: 'POST' })
        : await fetch(`/api/scheduled-tasks/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: t.status === 'active' ? 'paused' : 'active' }) })
    setNote(res.ok ? (what === 'run' ? 'Started.' : 'Saved.') : 'Could not do that.')
    await load()
  }

  if (off || (tasks !== null && tasks.length === 0)) return null
  return (
    <section aria-labelledby="instr-heading" className="r-sheet p-6">
      <h2 id="instr-heading" className="r-title">Your own instructions</h2>
      {tasks === null && <p className="r-meta mt-3">Reading.</p>}
      <ul className="mt-3 divide-y divide-[var(--r-line)]">
        {(tasks ?? []).map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1 basis-56">
              <p className="r-name">{t.name}</p>
              <p className="r-meta">{[t.card.schedule, t.status === 'paused' ? 'Paused' : null, t.card.last, t.card.next].filter(Boolean).join('. ')}</p>
            </div>
            <Key variant="raised" onClick={() => act(t, 'run')}>Run now</Key>
            <Key variant="ghost" onClick={() => act(t, 'toggle')}>{t.status === 'active' ? 'Pause' : 'Resume'}</Key>
          </li>
        ))}
      </ul>
      {note && <p className="r-meta mt-2" role="status">{note}</p>}
    </section>
  )
}
