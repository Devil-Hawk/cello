'use client'

// "Sources and tools" under an answer: the quiet line, which opens to the model and effort that ran, each tool, each task,
// each source, the time and the cost. Written by code from rows at the turn's end (lib/chat/disclosure.ts).

import { disclosureLine, type Disclosure } from '@/lib/chat/disclosure'
import { EFFORT_WORDS } from '@/components/chat/model-picker'
import { clock } from '@/components/chat/tasks-line'

const FREE = (model: string) => model.replace(/^[^/]*\//, '').replace(/:free$/, '')

export function SourcesAndTools({ d }: { d: Disclosure }) {
  const effort = EFFORT_WORDS[d.ran.effort as keyof typeof EFFORT_WORDS] ?? d.ran.effort
  const tools = [...new Set(d.tools.map((t) => t.label))]
  const sources = [...new Map(d.sources.map((s) => [`${s.title}|${s.host}`, s])).values()]
  return (
    <details className="text-caption text-muted-foreground">
      <summary className="cursor-pointer list-none hover:text-foreground">
        <span className="underline underline-offset-2">Sources and tools</span> · {disclosureLine(d)}
      </summary>
      <dl className="mt-2 space-y-1 rounded-control border border-border bg-card p-3">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0">Model</dt>
          <dd className="text-foreground">
            {FREE(d.ran.model)}, {effort}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0">Tools</dt>
          <dd className="text-foreground">{tools.length ? tools.join(', ') : 'None used'}</dd>
        </div>
        {d.workers.length > 0 && (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0">Tasks</dt>
            <dd className="text-foreground">{d.workers.map((w) => `${w.title} (${w.status}${w.reads ? `, ${w.reads} read` : ''})`).join('; ')}</dd>
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
