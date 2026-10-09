'use client'

import { useState } from 'react'
import { Check, ChevronDown, ListChecks, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DraftCheck } from '@/lib/writing/checks'

/**
 * The checks code can run on a draft (length, filler phrases, one ask, greeting,
 * sign-off). When all pass it is one quiet line that opens on a tap; when any
 * fail the failing rows are open, in plain sentences, with what to change.
 * The caller recomputes `checks` as the text changes, so an edit that breaks a
 * rule shows up at once.
 */
export function DraftChecks({ checks, className }: { checks: DraftCheck[]; className?: string }) {
  const failing = checks.filter((c) => !c.ok)
  const [toggled, setToggled] = useState(false)
  if (checks.length === 0) return null
  const open = failing.length > 0 || toggled

  return (
    <div className={cn('rounded-control border bg-sunken/40 p-2.5', className)}>
      <button
        type="button"
        onClick={() => setToggled((v) => !v)}
        disabled={failing.length > 0}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-caption font-medium text-foreground disabled:cursor-default"
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>{failing.length === 0 ? `All ${checks.length} checks passed` : `${checks.length - failing.length} of ${checks.length} checks passed`}</span>
        {failing.length === 0 && <ChevronDown className={cn('ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />}
      </button>
      {open && (
        <ul className="mt-2 space-y-1">
          {(failing.length > 0 ? failing : checks).map((c) => (
            <li key={c.id} className={cn('flex items-start gap-1.5 text-caption', c.ok ? 'text-muted-foreground' : 'font-medium text-pipeline-rejected')}>
              {c.ok ? <Check className="mt-0.5 h-3 w-3 shrink-0" /> : <X className="mt-0.5 h-3 w-3 shrink-0" />}
              <span className="break-words">{c.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
