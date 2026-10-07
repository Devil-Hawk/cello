'use client'

// The model picker under the compose box: shows the current choice ("Free models, Standard") and opens the ladder.
// Rungs above the person's highest, or not set up, are greyed with the reason. A choice applies to this chat from the
// next turn; "Just this message" applies once; "Use for new chats" also sets the person's default. The cost line is
// code's estimate, and "Cost not known before sending" when the model has no price.

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { RungInfo } from '@/lib/chat/settings'
import type { ModelChoice } from '@/lib/models/choice'
import { cn } from '@/lib/utils'

export type PickScope = 'chat' | 'once' | 'default'

export const EFFORT_WORDS = { low: 'Light', medium: 'Standard', high: 'Deep', xhigh: 'Deeper', max: 'Deepest' } as const
type PickableEffort = keyof typeof EFFORT_WORDS

export interface ModelPickerProps {
  choice: ModelChoice | null
  rungs: RungInfo[]
  /** The line next to Send, from models.estimate. */
  estimate?: string | null
  onPick: (choice: ModelChoice, scope: PickScope) => void
}

/** "Free models, Standard": the rung and the effort in the person's words. */
export function choiceWords(choice: ModelChoice | null, rungs: RungInfo[]): string {
  if (!choice) return 'Choose a model'
  const info = rungs.find((r) => r.rung === choice.rung)
  // The model's own name, so the line says what will answer: "Free models: laguna-s-2.1, Standard".
  const rung = info && info.models.length > 0 ? `${info.label}: ${info.models.find((m) => m.id === choice.model)?.label ?? choice.model}` : (info?.label ?? 'Model')
  const effort = EFFORT_WORDS[choice.effort as PickableEffort]
  return effort ? `${rung}, ${effort}` : rung
}

export function ModelPicker({ choice, rungs, estimate, onPick }: ModelPickerProps) {
  const [draft, setDraft] = useState<ModelChoice | null>(choice)
  const rung = rungs.find((r) => r.rung === draft?.rung)
  // Deeper and Deepest are for models on the person's own key.
  const efforts = (Object.keys(EFFORT_WORDS) as PickableEffort[]).filter((e) => draft?.rung === 'R4' || (e !== 'xhigh' && e !== 'max'))

  const pickRung = (r: RungInfo) => {
    if (r.why) return
    const model = r.models[0]?.id ?? draft?.model ?? ''
    setDraft({ rung: r.rung, model, effort: draft?.effort ?? 'medium' })
  }

  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-control px-2 py-1 text-caption text-muted-foreground hover:bg-muted hover:text-foreground">
        <span>{choiceWords(choice, rungs)}</span>
        {estimate && <span className="text-muted-foreground">· {estimate}</span>}
        <ChevronDown className="h-3 w-3" aria-hidden />
      </summary>
      <div className="absolute bottom-full left-0 z-30 mb-1 w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-card border border-border bg-card p-3 shadow-pop" role="group" aria-label="Model">
        <ul className="space-y-1">
          {rungs.map((r) => (
            <li key={r.rung}>
              <button
                type="button"
                disabled={Boolean(r.why)}
                aria-pressed={draft?.rung === r.rung}
                className={cn('flex w-full flex-col items-start rounded-control px-2 py-1.5 text-left text-caption hover:bg-muted disabled:pointer-events-none disabled:opacity-50', draft?.rung === r.rung && 'bg-muted')}
                onClick={() => pickRung(r)}
              >
                <span className="text-foreground">{r.label}</span>
                {r.why && <span className="text-muted-foreground">{r.why}</span>}
              </button>
            </li>
          ))}
        </ul>
        {rung && rung.models.length > 1 && (
          <label className="block text-caption text-muted-foreground">
            Model
            <select className="mt-1 block w-full rounded-control border border-input bg-background px-2 py-1 text-foreground" value={draft?.model} onChange={(e) => draft && setDraft({ ...draft, model: e.target.value })}>
              {rung.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {draft && (
          <label className="block text-caption text-muted-foreground">
            Effort
            <select className="mt-1 block w-full rounded-control border border-input bg-background px-2 py-1 text-foreground" value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value as ModelChoice['effort'] })}>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {EFFORT_WORDS[e]}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!draft?.model} className="rounded-control bg-primary px-2 py-1 text-caption text-primary-foreground disabled:opacity-40" onClick={() => draft && onPick(draft, 'chat')}>
            Use in this chat
          </button>
          <button type="button" disabled={!draft?.model} className="rounded-control border border-border px-2 py-1 text-caption text-foreground hover:bg-muted disabled:opacity-40" onClick={() => draft && onPick(draft, 'once')}>
            Just this message
          </button>
          <button type="button" disabled={!draft?.model} className="rounded-control border border-border px-2 py-1 text-caption text-foreground hover:bg-muted disabled:opacity-40" onClick={() => draft && onPick(draft, 'default')}>
            Use for new chats
          </button>
        </div>
      </div>
    </details>
  )
}
