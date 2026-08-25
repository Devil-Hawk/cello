'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Pencil, Wallet, X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { LinearMeter } from '@/components/charts/linear-meter'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/use-toast'

export interface BudgetSummary {
  spentUsd: number
  monthlyUsd: number
  /** "YYYY-MM" — the current billing period, from profiles.preferences.budget. */
  periodStart: string
}

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function formatPeriod(periodStart: string): string {
  const [year, month] = periodStart.split('-').map(Number)
  if (!year || !month) return periodStart
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

/**
 * "A single ratio against a limit" — a meter, not a chart (dataviz skill's
 * choosing-a-form table). Surfaces profiles.preferences.budget: the user runs
 * on a fixed monthly AI allowance and should see spend against it without
 * digging into Settings.
 *
 * The cap is EDITABLE here, in place. It was readable in three surfaces and
 * writable in none, so a user who hit their ceiling mid-session had no way to
 * raise it — and on a bring-your-own-key product the cap is the only control
 * the user has over what Cello may spend for them. Editing it where the number
 * already lives beats sending them to a settings tab to change a figure they
 * are currently looking at.
 */
export function BudgetMeterCard({
  budget,
  onBudgetChange,
}: {
  budget: BudgetSummary | null
  /** Called with the new cap after a successful save, so the dashboard can
   *  update without a full refetch. */
  onBudgetChange?: (monthlyUsd: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  function startEditing() {
    setDraft(budget ? String(budget.monthlyUsd) : '')
    setEditing(true)
  }

  async function save() {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast({
        title: 'That is not a budget',
        description: 'Enter a dollar amount, like 15.',
        variant: 'destructive',
      })
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/settings/budget', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthlyUsd: parsed }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? `Couldn't save (HTTP ${res.status})`)
      const saved = data?.budget?.monthlyUsd ?? parsed
      onBudgetChange?.(saved)
      setEditing(false)
      toast({ title: `Monthly cap set to ${formatUsd(saved)}` })
    } catch (e) {
      toast({
        title: "Couldn't save your budget",
        description: e instanceof Error ? e.message : 'Check your connection and try again.',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  if (!budget) {
    return (
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-body">AI budget</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-caption text-muted-foreground">No monthly budget configured yet.</p>
        </CardContent>
      </Card>
    )
  }

  const ratio = budget.monthlyUsd > 0 ? budget.spentUsd / budget.monthlyUsd : 0
  const remaining = Math.max(0, budget.monthlyUsd - budget.spentUsd)
  const overLimit = budget.spentUsd >= budget.monthlyUsd

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Wallet className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <CardTitle className="text-body">AI budget</CardTitle>
          <CardDescription>{formatPeriod(budget.periodStart)}</CardDescription>
        </div>
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            onClick={startEditing}
            aria-label={`Change the monthly cap, currently ${formatUsd(budget.monthlyUsd)}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-readout text-readout tabular-nums text-foreground">
            {formatUsd(budget.spentUsd)}
          </span>
          {editing ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <label htmlFor="budget-cap" className="text-caption text-muted-foreground">
                of $
              </label>
              <Input
                id="budget-cap"
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Escape abandons the edit — the standard exit from an inline
                  // editor, and without it the only way out is a mouse.
                  if (e.key === 'Escape') setEditing(false)
                }}
                inputMode="decimal"
                disabled={saving}
                className="h-7 w-20 text-right font-readout tabular-nums"
                aria-label="Monthly AI budget in dollars"
              />
              <Button type="submit" size="icon" variant="ghost" disabled={saving} aria-label="Save budget">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={saving}
                aria-label="Cancel"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </form>
          ) : (
            <span className="text-caption text-muted-foreground">
              of {formatUsd(budget.monthlyUsd)}
            </span>
          )}
        </div>
        <LinearMeter
          ratio={ratio}
          label={`AI budget: ${formatUsd(budget.spentUsd)} of ${formatUsd(budget.monthlyUsd)} spent this month`}
        />
        <p className="text-caption text-muted-foreground">
          {overLimit
            ? 'Monthly budget reached — new AI calls may be blocked until next period. Raise the cap above to keep going.'
            : `${formatUsd(remaining)} left this month.`}
        </p>
      </CardContent>
    </Card>
  )
}
