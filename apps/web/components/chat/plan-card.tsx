'use client'

// The list Cello shows before it does a lot at once: the things it plans to do, each of which can be moved or taken
// off, then Go ahead or Cancel. Nothing has started while this shows. The titles are written by code from the rows.

import { useEffect, useReducer, useRef } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'

export interface PlanStep {
  id: string
  title: string
}

export type PlanAction = { type: 'up' | 'down' | 'remove'; id: string } | { type: 'reset'; ids: string[] }

/** The ids still kept, in the order the person arranged them. */
export function planReducer(ids: string[], action: PlanAction): string[] {
  if (action.type === 'reset') return action.ids
  if (action.type === 'remove') return ids.filter((id) => id !== action.id)
  const at = ids.indexOf(action.id)
  const to = at + (action.type === 'up' ? -1 : 1)
  if (at < 0 || to < 0 || to >= ids.length) return ids
  const next = [...ids]
  next[at] = ids[to]
  next[to] = action.id
  return next
}

/** Which Remove key takes the focus once the step is gone: the one that took its place, else the last. -1 means the list is empty. */
export function focusAfterRemove(ids: string[], id: string): number {
  return Math.min(ids.indexOf(id), ids.length - 2)
}

export interface PlanCardViewProps {
  /** Every step as it came; ids picks which are kept and their order. */
  steps: PlanStep[]
  ids: string[]
  busy?: boolean
  onGo: (keep: string[]) => void
  onCancel: () => void
  dispatch: (action: PlanAction) => void
}

const BUTTON =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border bg-card px-3 py-1 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40'

export function PlanCardView({ steps, ids, busy = false, onGo, onCancel, dispatch }: PlanCardViewProps) {
  const title = new Map(steps.map((s) => [s.id, s.title]))
  const empty = ids.length === 0
  const n = empty ? steps.length : ids.length
  return (
    <div role="group" aria-label="Plan" className="space-y-3 rounded-card border border-border bg-card p-3 text-body text-foreground" data-plan-card>
      <div className="space-y-1">
        <p>{empty ? 'Nothing is left to do. Cancel, or put them back.' : n === 1 ? 'Cello will do this once you agree.' : `Cello will do these ${n} things once you agree.`}</p>
        {!empty && <p className="text-caption text-muted-foreground">Remove any you do not want, or move them up or down.</p>}
      </div>
      {!empty && (
        <ol className="space-y-1.5">
          {ids.map((id, i) => {
            const t = title.get(id) ?? ''
            return (
              <li key={id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 flex-1 break-words">{t}</span>
                <span className="flex items-center gap-1">
                  <button type="button" className={BUTTON} disabled={busy} aria-disabled={i === 0 || undefined} aria-label={`Move up: ${t}`} onClick={i === 0 ? undefined : () => dispatch({ type: 'up', id })}>
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </button>
                  <button type="button" className={BUTTON} disabled={busy} aria-disabled={i === ids.length - 1 || undefined} aria-label={`Move down: ${t}`} onClick={i === ids.length - 1 ? undefined : () => dispatch({ type: 'down', id })}>
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </button>
                  <button type="button" className={BUTTON} disabled={busy} aria-label={`Remove: ${t}`} data-plan-remove onClick={() => dispatch({ type: 'remove', id })}>
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </span>
              </li>
            )
          })}
        </ol>
      )}
      <div className="flex flex-wrap gap-2 text-caption">
        <button type="button" className={BUTTON} disabled={busy} aria-disabled={empty || undefined} onClick={empty ? undefined : () => onGo(ids)}>
          Go ahead
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {empty && (
          <button type="button" className={BUTTON} disabled={busy} data-plan-put-back onClick={() => dispatch({ type: 'reset', ids: steps.map((s) => s.id) })}>
            Put them back
          </button>
        )}
      </div>
    </div>
  )
}

export interface PlanCardProps {
  steps: PlanStep[]
  busy?: boolean
  onGo: (keep: string[]) => void
  onCancel: () => void
}

export function PlanCard({ steps, busy, onGo, onCancel }: PlanCardProps) {
  const [ids, dispatch] = useReducer(planReducer, steps.map((s) => s.id))
  const root = useRef<HTMLDivElement>(null)
  const refocus = useRef<number | null>(null)
  // The focused Remove key unmounts with its row, so hand the focus on once the list has changed.
  useEffect(() => {
    const at = refocus.current
    if (at === null) return
    refocus.current = null
    const el = at < 0 ? root.current?.querySelector('[data-plan-put-back]') : root.current?.querySelectorAll('[data-plan-remove]')[at]
    ;(el as HTMLElement | null | undefined)?.focus()
  }, [ids])
  const act = (a: PlanAction) => {
    if (a.type === 'remove') refocus.current = focusAfterRemove(ids, a.id)
    if (a.type === 'reset') refocus.current = 0 // Put them back unmounts too: the first Remove key takes the focus
    dispatch(a)
  }
  return (
    <div ref={root}>
      <PlanCardView steps={steps} ids={ids} busy={busy} onGo={onGo} onCancel={onCancel} dispatch={act} />
    </div>
  )
}
