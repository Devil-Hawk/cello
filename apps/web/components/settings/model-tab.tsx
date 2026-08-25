'use client'

import { useEffect, useState } from 'react'
import { CheckCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MODELS, DEFAULT_MODEL_ID, resolveModelId, type ModelId } from '@/lib/models'
import { REASONING_EFFORTS, type ReasoningEffort } from '@/lib/harness/types'

export interface ModelTabProps {
  initialModel: string | null
  onStatus: (status: 'success' | 'error', message: string) => void
}

const REASONING_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-high',
  max: 'Max',
}

const REASONING_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  none: 'No extended thinking — fastest and cheapest, the historical default.',
  minimal: 'A brief extra pass before answering.',
  low: 'A light reasoning pass on hard steps.',
  medium: "Cello's own agents use this for scoring, planning, and drafting — a real quality bump.",
  high: "Heavy reasoning. This is Gemini's ceiling — Cello caps any higher rung back down to this for Gemini models.",
  xhigh: 'Very heavy reasoning. On Claude models this allocates roughly 32k thinking tokens per call.',
  max: 'Maximum reasoning. On Claude models this allocates roughly 64k thinking tokens per call — expect real added cost and latency.',
}

/**
 * Per-user model selector. Persists to profiles.preferences.model via
 * /api/settings/model. Every agent + the copilot inherit this choice through
 * loadApiKeys() → callLlm(); when unset the harness falls back to DEFAULT_MODEL_ID.
 *
 * Model list/labels/descriptions come from @/lib/models — the single source
 * of truth shared with the route handler and the harness.
 */
export function ModelTab({ initialModel, onStatus }: ModelTabProps) {
  const [selected, setSelected] = useState<ModelId>(resolveModelId(initialModel))
  const [savedModel, setSavedModel] = useState<string | null>(initialModel)
  const [isSaving, setIsSaving] = useState(false)

  // Reasoning effort lives at profiles.preferences.reasoningEffort, saved via
  // the provider route (POST /api/settings/providers already owns
  // read-modify-write on that jsonb blob) rather than duplicating that logic
  // here. Self-fetched on mount — same pattern as ConnectionsTab/ProviderTab —
  // so this tab doesn't need a prop threaded through settings/page.tsx.
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('none')
  const [savedReasoningEffort, setSavedReasoningEffort] = useState<ReasoningEffort>('none')
  const [isSavingReasoning, setIsSavingReasoning] = useState(false)
  const [reasoningLoaded, setReasoningLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadReasoning() {
      try {
        const res = await fetch('/api/settings/providers')
        if (res.ok) {
          const data = await res.json()
          const effort = REASONING_EFFORTS.includes(data.reasoningEffort) ? data.reasoningEffort : 'none'
          if (!cancelled) {
            setReasoningEffort(effort)
            setSavedReasoningEffort(effort)
          }
        }
      } catch {
        // Leave the 'none' default — the slider still works, it just starts unsaved.
      } finally {
        if (!cancelled) setReasoningLoaded(true)
      }
    }
    loadReasoning()
    return () => {
      cancelled = true
    }
  }, [])

  async function saveModel() {
    setIsSaving(true)
    try {
      const response = await fetch('/api/settings/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selected }),
      })
      const result = await response.json()
      if (result.error) {
        onStatus('error', result.error)
      } else {
        setSavedModel(result.model)
        onStatus('success', 'Model preference saved')
      }
    } catch {
      onStatus('error', 'Failed to save model')
    }
    setIsSaving(false)
  }

  async function saveReasoningEffort() {
    setIsSavingReasoning(true)
    try {
      const response = await fetch('/api/settings/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reasoningEffort }),
      })
      const result = await response.json()
      if (!response.ok || result.error) {
        onStatus('error', result.error || 'Failed to save reasoning effort')
      } else {
        setSavedReasoningEffort(reasoningEffort)
        onStatus('success', 'Reasoning effort saved')
      }
    } catch {
      onStatus('error', 'Failed to save reasoning effort')
    }
    setIsSavingReasoning(false)
  }

  const reasoningIndex = REASONING_EFFORTS.indexOf(reasoningEffort)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-section text-foreground">Model</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          Choose the model that powers matching, drafting, research, and the copilot. This uses your
          OpenRouter key. When unset, Cello uses {DEFAULT_MODEL_ID}.
        </p>
      </div>

      <div className="space-y-3">
        {MODELS.map((model) => {
          const active = selected === model.id
          const isSaved = savedModel === model.id
          return (
            <button
              key={model.id}
              type="button"
              onClick={() => setSelected(model.id)}
              className={cn(
                'flex w-full items-start gap-3 rounded-card border p-4 text-left transition-colors',
                active
                  ? 'border-primary bg-accent-soft'
                  : 'border-border bg-card hover:bg-muted'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                  active ? 'border-primary' : 'border-input'
                )}
                aria-hidden
              >
                {active && <span className="h-2 w-2 rounded-full bg-primary" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-body font-medium text-foreground">{model.label}</span>
                  <span className="rounded-full bg-sunken px-1.5 py-0.5 text-caption uppercase text-muted-foreground">
                    {model.tier}
                  </span>
                  {isSaved && (
                    <span className="flex items-center gap-1 text-caption text-emerald-600 dark:text-emerald-400">
                      <CheckCircle className="h-3 w-3" />
                      Active
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-caption text-muted-foreground">
                  {model.description}
                </span>
                <span className="mt-1 block font-mono text-caption text-muted-foreground/70">
                  {model.id}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="pt-1">
        <Button onClick={saveModel} disabled={isSaving || selected === savedModel}>
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save model
        </Button>
      </div>

      <div className="border-t pt-6">
        <h3 className="text-body font-medium text-foreground">Reasoning effort</h3>
        <p className="mt-1 text-caption text-muted-foreground">
          The default amount of extended thinking Cello asks for when an agent call doesn&apos;t already
          set its own effort. Reasoning tokens bill as <span className="font-medium">output</span> tokens —
          higher rungs cost more and take longer, not just &quot;think harder for free.&quot; Claude models map
          each rung to a thinking-token budget; Gemini caps at High and treats X-high/Max the same as High.
          Only applies to the OpenRouter provider today.
        </p>

        <div className="mt-5 px-1">
          <input
            type="range"
            min={0}
            max={REASONING_EFFORTS.length - 1}
            step={1}
            value={Math.max(0, reasoningIndex)}
            disabled={!reasoningLoaded}
            onChange={(e) => setReasoningEffort(REASONING_EFFORTS[Number(e.target.value)])}
            style={{ accentColor: 'hsl(var(--accent))' }}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sunken disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Default reasoning effort"
          />
          <div className="mt-1.5 grid grid-cols-7 text-center text-caption text-muted-foreground">
            {REASONING_EFFORTS.map((effort) => (
              <span
                key={effort}
                className={cn(effort === reasoningEffort && 'font-medium text-foreground')}
              >
                {REASONING_LABELS[effort]}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-3 rounded-card bg-sunken p-3">
          <p className="text-caption text-foreground">{REASONING_DESCRIPTIONS[reasoningEffort]}</p>
        </div>

        <div className="mt-3">
          <Button
            onClick={saveReasoningEffort}
            disabled={isSavingReasoning || !reasoningLoaded || reasoningEffort === savedReasoningEffort}
            variant="outline"
          >
            {isSavingReasoning && <Loader2 className="h-4 w-4 animate-spin" />}
            Save reasoning effort
          </Button>
        </div>
      </div>
    </div>
  )
}
