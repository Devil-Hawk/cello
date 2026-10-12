'use client'

// "Sources and tools" under an answer: the quiet line, which opens to the model and effort that ran, each tool, each task,
// each source, the time and the cost. Written by code from rows at the turn's end (lib/chat/disclosure.ts).

import { disclosureLine, type Disclosure } from '@/lib/chat/disclosure'
import { EFFORT_WORDS, STEP_DOWN_WORDS } from '@/components/chat/model-picker'
import { clock, STATUS_WORDS, type TaskStatus } from '@/components/chat/tasks-line'

const FREE = (model: string) => model.replace(/^[^/]*\//, '').replace(/:free$/, '')

/** "laguna-s-2.1, Standard (gemma-4-31b-it did not answer)", or that no model ran: the ledger's answer, not the choice. */
export function modelWords(ran: Disclosure['ran']): string {
  if (!ran) return 'None. Code answered this.'
  const effort = EFFORT_WORDS[ran.effort as keyof typeof EFFORT_WORDS] ?? ran.effort
  const down = ran.steppedDown && ran.steppedDown.wanted.model !== ran.model ? ` (${FREE(ran.steppedDown.wanted.model)} ${STEP_DOWN_WORDS[ran.steppedDown.why]})` : ''
  return `${FREE(ran.model)}, ${effort}${down}`
}

export function SourcesAndTools({ d }: { d: Disclosure }) {
  const tools = [...new Set(d.tools.map((t) => t.label))]
  const sources = [...new Map(d.sources.map((s) => [`${s.title}|${s.host}`, s])).values()]
  return (
    <details className="text-caption text-muted-foreground">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-1 hover:text-foreground">
        <span className="underline underline-offset-2">Sources and tools</span>
        <span>· {disclosureLine(d)}</span>
      </summary>
      <dl className="mt-2 space-y-1 rounded-control border border-border bg-card p-3">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0">Model</dt>
          <dd className="text-foreground">{modelWords(d.ran)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0">Tools</dt>
          <dd className="text-foreground">{tools.length ? tools.join(', ') : 'None used'}</dd>
        </div>
        {d.workers.length > 0 && (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0">Tasks</dt>
            <dd className="text-foreground">{d.workers.map((w) => `${w.title} (${STATUS_WORDS[w.status as TaskStatus] ?? w.status}${w.reads ? `, ${w.reads} read` : ''})`).join('; ')}</dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="w-16 shrink-0">Sources</dt>
          <dd className="min-w-0 break-words text-foreground">{sources.length ? sources.slice(0, 12).map((s) => `${s.title}, ${s.host}`).join('; ') : 'None'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0">Time</dt>
          <dd className="text-foreground">{clock(d.seconds)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0">Cost</dt>
          <dd className="text-foreground">{d.costUsd === 0 ? 'Free' : d.costUsd < 0.01 ? 'Under $0.01' : `$${d.costUsd.toFixed(2)}`}</dd>
        </div>
      </dl>
    </details>
  )
}
