'use client'

// The tasks line under the person's turn, read from agent_tasks rows: while a turn runs, "Cello is working: 3 of 4 done.
// 0:42" with Show and Stop; Show lists each task with what it is doing, what it has read, its state and its own Stop.
// When the turn ends the line folds to what was done. After a reload the rows rebuild it: nothing here is kept in memory.

import { useState } from 'react'
import { cn } from '@/lib/utils'

export type TaskStatus = 'queued' | 'working' | 'waiting' | 'done' | 'partial' | 'failed' | 'stopped'

export interface TaskRow {
  id: string
  title: string
  status: TaskStatus
  command: string | null
  /** How many things the task has read. */
  reads: number
}

export const STATUS_WORDS: Record<TaskStatus, string> = {
  queued: 'Waiting',
  working: 'Working',
  waiting: 'Waiting for your approval',
  done: 'Done',
  partial: 'Done in part',
  failed: 'Could not finish',
  stopped: 'Stopped',
}

const alive = (s: TaskStatus) => s === 'queued' || s === 'working'

/** m:ss */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.max(0, Math.floor(seconds % 60))).padStart(2, '0')}`

const DONE_WORDS: Record<string, [string, string, string]> = {
  'companies.research': ['researched', 'company', 'companies'],
  'companies.check': ['checked', 'employer', 'employers'],
  'documents.draft': ['drafted', 'draft', 'drafts'],
  'roles.check_chance': ['checked', 'role', 'roles'],
  'applications.start': ['started', 'application', 'applications'],
}

/** "Worked 0:41: researched 3 companies, drafted 1 draft." from the rows, never from the model. */
export function workedSummary(tasks: TaskRow[], seconds: number): string {
  const counts = new Map<string, number>()
  for (const t of tasks) if (t.status === 'done' || t.status === 'partial') counts.set(t.command ?? '', (counts.get(t.command ?? '') ?? 0) + 1)
  const parts = [...counts].map(([command, n]) => {
    const words = DONE_WORDS[command]
    return words ? `${words[0]} ${n} ${n === 1 ? words[1] : words[2]}` : `finished ${n} ${n === 1 ? 'task' : 'tasks'}`
  })
  return `Worked ${clock(seconds)}${parts.length ? `: ${parts.join(', ')}` : ''}.`
}

export interface TasksLineProps {
  tasks: TaskRow[]
  /** True while the turn runs. */
  running: boolean
  seconds: number
  onStop: () => void
  onStopTask: (id: string) => void
  /** Show the list at first (the page remembers what the person chose). */
  defaultOpen?: boolean
}

export function TasksLine({ tasks, running, seconds, onStop, onStopTask, defaultOpen = false }: TasksLineProps) {
  const [open, setOpen] = useState(defaultOpen)
  if (tasks.length === 0) return null
  const finished = tasks.filter((t) => !alive(t.status) && t.status !== 'waiting').length
  return (
    <div className="rounded-control border border-border bg-card px-3 py-2 text-caption" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-foreground">{running ? `Cello is working: ${finished} of ${tasks.length} done. ${clock(seconds)}` : workedSummary(tasks, seconds)}</span>
        <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </button>
        {running && (
          <button type="button" className="rounded-control border border-input px-2 py-0.5 text-foreground hover:bg-muted" onClick={onStop}>
            Stop
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5" data-task={t.status}>
              <span className="min-w-0 flex-1 break-words text-foreground">{t.title}</span>
              <span className={cn('text-muted-foreground', t.status === 'failed' && 'text-foreground')}>{STATUS_WORDS[t.status]}</span>
              {t.reads > 0 && <span className="text-muted-foreground">{t.reads} {t.reads === 1 ? 'page' : 'pages'} read</span>}
              {alive(t.status) && (
                <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" aria-label={`Stop: ${t.title}`} onClick={() => onStopTask(t.id)}>
                  Stop
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
