'use client'

// Models (blueprint 4.12): what Cello uses now, the highest it may use, the doors in the person's order with their
// state, the free count, the $10 credit switch. Read from models.get, written through settings.models. The tabs that
// hold the person's own key, the default model and effort, and this computer's provider sit under it.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Key } from '@/components/ui/key'
import { ChatModel } from './chat-model'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export type Door = 'R1' | 'R2' | 'R3' | 'R4'
export type Ceiling = 'R0' | Door

export interface ModelsView {
  rungs: { rung: Door; state: 'ready' | 'not_set_up' }[]
  ceiling: Ceiling
  order: Door[]
  creditBought: boolean
  freeToday: number
  freeLimit: number
  resetsAt: string
}

export const DOOR_NAME: Record<Ceiling, string> = { R0: 'No model', R1: 'This browser', R2: 'This computer', R3: 'Free models', R4: 'Your own key' }
const CEILINGS: Ceiling[] = ['R0', 'R1', 'R2', 'R3', 'R4']
const CREDIT_SENTENCE = '1,000 a day after you buy $10 of OpenRouter credit.'

/** The door Cello uses now: the first in the person's order that is set up and not above the highest they allow. */
export function usingNow(v: ModelsView): Ceiling {
  const top = CEILINGS.indexOf(v.ceiling)
  return v.order.find((d) => CEILINGS.indexOf(d) <= top && v.rungs.find((r) => r.rung === d)?.state === 'ready') ?? 'R0'
}

export function freeLine(v: ModelsView): ReactNode {
  const reset = new Date(v.resetsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return (
    <>
      {v.freeToday} of{' '}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center underline decoration-dotted" aria-describedby="credit-sentence">
            {v.freeLimit}
          </button>
        </TooltipTrigger>
        <TooltipContent>{CREDIT_SENTENCE}</TooltipContent>
      </Tooltip>{' '}
      free requests today. Resets {reset}.
      <span id="credit-sentence" className="sr-only">{CREDIT_SENTENCE}</span>
    </>
  )
}

export type ModelsPatch = { ceiling?: Ceiling; order?: Door[]; creditBought?: boolean }

/** The view of models.get as the person reads it. Pure: the fixtures of the tests render it directly. */
export function ModelsPanel({ view, error, onSave, children }: { view: ModelsView; error?: string | null; onSave: (patch: ModelsPatch) => void; children?: ReactNode }) {
  const now = usingNow(view)
  function move(i: number, by: -1 | 1) {
    const next = [...view.order]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    onSave({ order: next })
  }
  return (
    <TooltipProvider>
      <div className="space-y-6">
        <p className="r-body">
          Cello uses: <span className="r-name">{DOOR_NAME[now]}</span>.{now === 'R0' ? ' Its own checks still run, and every draft is yours to write.' : ''}
        </p>

        <fieldset className="space-y-1">
          <legend className="r-name">Highest Cello may use</legend>
          {CEILINGS.map((c) => (
            <label key={c} className="flex min-h-11 items-center gap-3">
              <input type="radio" name="ceiling" className="h-4 w-4" checked={view.ceiling === c} onChange={() => onSave({ ceiling: c })} />
              <span className="r-body">{DOOR_NAME[c]}</span>
            </label>
          ))}
        </fieldset>

        <div>
          <h3 className="r-name">Your doors, in your order</h3>
          <ol className="divide-y divide-[var(--r-line)]">
            {view.order.map((d, i) => {
              const ready = view.rungs.find((r) => r.rung === d)?.state === 'ready'
              return (
                <li key={d} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
                  <span className="r-body min-w-0 flex-1 basis-40">{DOOR_NAME[d]}</span>
                  <span className="r-meta">{ready ? 'Ready' : 'Not set up'}</span>
                  <Key variant="ghost" aria-label={`Move ${DOOR_NAME[d]} up`} disabled={i === 0} onClick={() => move(i, -1)}>Up</Key>
                  <Key variant="ghost" aria-label={`Move ${DOOR_NAME[d]} down`} disabled={i === view.order.length - 1} onClick={() => move(i, 1)}>Down</Key>
                </li>
              )
            })}
          </ol>
        </div>

        <div className="space-y-1">
          <p className="r-body">{freeLine(view)}</p>
          <label className="flex min-h-11 items-center gap-3">
            <input type="checkbox" role="switch" className="h-4 w-4" checked={view.creditBought} onChange={(e) => onSave({ creditBought: e.target.checked })} />
            <span className="r-body">I have bought $10 of OpenRouter credit</span>
          </label>
        </div>
        {error && <p className="r-meta" role="alert">{error}</p>}
        <ChatModel />
        {children}
      </div>
    </TooltipProvider>
  )
}

export function ModelsSection({ children }: { children?: ReactNode }) {
  const [view, setView] = useState<ModelsView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/models')
      if (!res.ok) throw new Error(String(res.status))
      setView((await res.json()) as ModelsView)
      setError(null)
    } catch {
      setError('Could not read your models. Try again.')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function save(patch: ModelsPatch) {
    setError(null)
    const res = await fetch('/api/settings/models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (!res.ok) setError('Could not save. Nothing changed.')
    await load()
  }

  if (!view) return error ? <p className="r-body" role="alert">{error} <button type="button" className="underline" onClick={load}>Try again</button></p> : <p className="r-meta">Reading.</p>
  return <ModelsPanel view={view} error={error} onSave={save}>{children}</ModelsPanel>
}
