'use client'

import { useEffect, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { EMPTY_TARGETING, type Targeting } from '@/lib/targeting'
import { JOB_FUNCTIONS, SENIORITY_LEVELS, type JobFunction, type Seniority } from '@/lib/jobs/classify'

export interface TargetingTabProps {
  initialTargeting: Targeting
  onStatus: (status: 'success' | 'error', message: string) => void
}

// Mirrors the `counts` field of POST /api/settings/targeting/impact's
// response, which is lib/strategy/datasource.ts's JobScopeCounts passed
// through untouched. Declared locally (not imported) because that module
// pulls in the service-role Supabase admin client — this is a client
// component and must never bundle that.
interface TargetingImpact {
  totalJobs: number
  totalPassingAllConfiguredFilters: number
  jobsWithNoDescription: number
  /** Jobs excluded by ONE dimension alone, holding every other dimension open. Keyed by 'functions' | 'seniority' | 'countries' | 'remoteOnly' | 'languages'; a dimension is absent (not zero) when it isn't currently configured. */
  excludedByDimension: Record<string, number>
  /** Combined impact of excludedCompanies + excludedKeywords together (the datasource can't attribute a match to one list or the other). Null when both are empty. */
  excludedByKeywords: number | null
  /** What targeting.minScore WOULD exclude if anything enforced it. Null when minScore is unset. See the Field below — nothing reads this today. */
  excludedByMinScoreHypothetical: number | null
}

type ImpactStatus = 'loading' | 'ready' | 'error'

const fmt = (n: number) => n.toLocaleString()

/** >90% of tracked jobs excluded by a single, currently-configured dimension. Words carry the meaning; colour is just a highlight, per globals.css's "accent means live" rule — this reuses pipeline.screen (the same ochre Panel's `warn` tone uses), never accent orange. */
function isAlarming(excluded: number, total: number): boolean {
  return total > 0 && excluded / total > 0.9
}

/**
 * Per-Field "what does this filter cost" line.
 *
 * `active` is whether THIS dimension currently constrains anything — when it
 * doesn't (empty list / toggle off), the datasource never even runs that
 * query (see excludedByDimension's doc in lib/strategy/datasource.ts), so
 * there is nothing honest to show and this renders nothing, not a fabricated
 * zero. When active, it tracks the shared fetch's status: a loading spinner
 * while a debounced edit is in flight, a quiet failure note if it errored
 * (never a stale number presented as current), otherwise the count.
 */
function ImpactNote({
  active,
  status,
  excluded,
  total,
  prefix = 'excludes',
}: {
  active: boolean
  status: ImpactStatus
  /** Meaningful only once status === 'ready'; null there means the response didn't include this dimension. */
  excluded: number | null
  total: number
  prefix?: string
}) {
  if (!active) return null
  if (status === 'loading') {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Calculating impact…
      </p>
    )
  }
  if (status === 'error') {
    return <p className="mt-2 text-caption text-muted-foreground">Couldn&apos;t calculate impact right now.</p>
  }
  if (excluded === null) return null
  const alarming = isAlarming(excluded, total)
  return (
    <p className={cn('mt-2 text-caption tabular-nums', alarming ? 'font-medium text-pipeline-screen' : 'text-muted-foreground')}>
      {prefix} {fmt(excluded)} of {fmt(total)} tracked jobs
      {alarming && ' — more than 90% of what you track'}
    </p>
  )
}

const FUNCTION_LABELS: Record<JobFunction, string> = {
  engineering: 'Engineering',
  data: 'Data',
  product: 'Product',
  design: 'Design',
  sales: 'Sales',
  marketing: 'Marketing',
  support: 'Support',
  operations: 'Operations',
  finance: 'Finance',
  hr: 'HR',
  legal: 'Legal',
  other: 'Other',
}

const SENIORITY_LABELS: Record<Seniority, string> = {
  intern: 'Intern',
  junior: 'Junior',
  mid: 'Mid',
  senior: 'Senior',
  staff: 'Staff',
  principal: 'Principal',
  manager: 'Manager',
  director: 'Director',
  exec: 'Executive',
  unknown: 'Unknown',
}

function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** Small "add a chip, press enter or click +" text list editor. */
function TagListEditor({
  values,
  onChange,
  placeholder,
  transform,
}: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder: string
  transform: (s: string) => string
}) {
  const [draft, setDraft] = useState('')

  function commit() {
    const normalized = transform(draft.trim())
    if (!normalized) return
    if (!values.includes(normalized)) onChange([...values, normalized])
    setDraft('')
  }

  return (
    <div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" size="icon" onClick={commit} aria-label="Add">
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-full border bg-sunken px-2 py-0.5 text-caption text-foreground"
            >
              {v}
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                aria-label={`Remove ${v}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Field({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-card border bg-card p-4">
      <p className="text-body font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-caption text-muted-foreground">{hint}</p>
      <div className="mt-3">{children}</div>
    </div>
  )
}

/**
 * Editor for profiles.preferences.targeting. There are NO opinionated
 * defaults — every field starts from whatever is saved, and an empty field
 * means "no constraint on this dimension", not "use our guess". This is what
 * job discovery (ingest relevance), the jobs list defaults, and auto-triage
 * (matcher scoring / the digest) all read through resolveTargeting().
 */
export function TargetingTab({ initialTargeting, onStatus }: TargetingTabProps) {
  const [targeting, setTargeting] = useState<Targeting>(initialTargeting)
  const [saved, setSaved] = useState<Targeting>(initialTargeting)
  const [minScoreInput, setMinScoreInput] = useState<string>(
    initialTargeting.minScore === null ? '' : String(initialTargeting.minScore)
  )
  const [isSaving, setIsSaving] = useState(false)

  // Cost-of-filter preview for the CURRENT pending (possibly unsaved) state.
  // Debounced because every keystroke in a TagListEditor would otherwise fire
  // a count query — see app/api/settings/targeting/impact/route.ts. Fetches
  // on every `targeting` change, including the initial mount, so the numbers
  // are visible before the user touches anything.
  const [impact, setImpact] = useState<TargetingImpact | null>(null)
  const [impactStatus, setImpactStatus] = useState<ImpactStatus>('loading')

  useEffect(() => {
    const controller = new AbortController()
    setImpactStatus('loading')
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/settings/targeting/impact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(targeting),
          signal: controller.signal,
        })
        const result = await response.json()
        if (!response.ok || result.error) {
          setImpactStatus('error')
          return
        }
        setImpact(result.counts)
        setImpactStatus('ready')
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return // superseded by a newer edit, not a real failure
        setImpactStatus('error')
      }
    }, 450)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [targeting])

  const isDirty = JSON.stringify(targeting) !== JSON.stringify(saved)

  function set<K extends keyof Targeting>(key: K, value: Targeting[K]) {
    setTargeting((prev) => ({ ...prev, [key]: value }))
  }

  async function save() {
    setIsSaving(true)
    try {
      const response = await fetch('/api/settings/targeting', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(targeting),
      })
      const result = await response.json()
      if (result.error) {
        onStatus('error', result.error)
      } else {
        setTargeting(result.targeting)
        setSaved(result.targeting)
        setMinScoreInput(result.targeting.minScore === null ? '' : String(result.targeting.minScore))
        onStatus('success', 'Targeting preferences saved')
      }
    } catch {
      onStatus('error', 'Failed to save targeting')
    }
    setIsSaving(false)
  }

  function resetAll() {
    setTargeting(EMPTY_TARGETING)
    setMinScoreInput('')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-section text-foreground">Job targeting</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          You chose to configure targeting yourself — nothing here is pre-filled with an opinionated
          guess. Leave a field empty and it constrains nothing. These settings drive three things:
          which jobs get ingested as relevant, what the jobs list shows by default, and how
          auto-triage (match scoring, the digest, and excluded-job filtering) treats a job.
        </p>
      </div>

      <Field
        title="Job functions"
        hint="Which functions to target. Empty = any function."
      >
        <div className="flex flex-wrap gap-2">
          {JOB_FUNCTIONS.map((fn) => {
            const active = targeting.functions.includes(fn)
            return (
              <button
                key={fn}
                type="button"
                onClick={() => set('functions', toggleValue(targeting.functions, fn))}
                className={cn(
                  'rounded-full border px-3 py-1 text-caption transition-colors',
                  active
                    ? 'border-primary bg-accent-soft text-accent-deep'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {FUNCTION_LABELS[fn]}
              </button>
            )
          })}
        </div>
        <ImpactNote
          active={targeting.functions.length > 0}
          status={impactStatus}
          excluded={impact?.excludedByDimension.functions ?? null}
          total={impact?.totalJobs ?? 0}
        />
      </Field>

      <Field
        title="Seniority"
        hint="Which seniority levels to target. Empty = any level."
      >
        <div className="flex flex-wrap gap-2">
          {SENIORITY_LEVELS.map((level) => {
            const active = targeting.seniority.includes(level)
            return (
              <button
                key={level}
                type="button"
                onClick={() => set('seniority', toggleValue(targeting.seniority, level))}
                className={cn(
                  'rounded-full border px-3 py-1 text-caption transition-colors',
                  active
                    ? 'border-primary bg-accent-soft text-accent-deep'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {SENIORITY_LABELS[level]}
              </button>
            )
          })}
        </div>
      </Field>

      <Field
        title="Countries"
        hint="ISO country codes (e.g. US, DE, GB). Empty = any country. Press Enter or + to add."
      >
        <TagListEditor
          values={targeting.countries}
          onChange={(v) => set('countries', v)}
          placeholder="US"
          transform={(s) => s.toUpperCase()}
        />
      </Field>

      <Field
        title="Remote only"
        hint="When on, only jobs classified as remote are targeted. Off = no constraint."
      >
        <button
          type="button"
          role="switch"
          aria-checked={targeting.remoteOnly}
          onClick={() => set('remoteOnly', !targeting.remoteOnly)}
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition-colors',
            targeting.remoteOnly ? 'bg-primary' : 'bg-border'
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-card shadow-card transition-transform',
              targeting.remoteOnly ? 'translate-x-[22px]' : 'translate-x-0.5'
            )}
          />
        </button>
      </Field>

      <Field
        title="Languages"
        hint="ISO 639-1 language codes (e.g. en, de, fr). Empty = any language. Press Enter or + to add."
      >
        <TagListEditor
          values={targeting.languages}
          onChange={(v) => set('languages', v)}
          placeholder="en"
          transform={(s) => s.toLowerCase()}
        />
      </Field>

      <Field
        title="Minimum match score"
        hint="Hide jobs scored below this out of 100. Leave blank for no minimum. Only meaningful once jobs have a match_score."
      >
        <Input
          type="number"
          min={0}
          max={100}
          value={minScoreInput}
          onChange={(e) => {
            const raw = e.target.value
            setMinScoreInput(raw)
            if (raw.trim() === '') {
              set('minScore', null)
              return
            }
            const n = Number(raw)
            if (Number.isFinite(n)) set('minScore', Math.max(0, Math.min(100, Math.round(n))))
          }}
          placeholder="No minimum"
          className="max-w-[10rem]"
        />
      </Field>

      <Field
        title="Excluded companies"
        hint="Company names to never surface, anywhere. Empty = exclude nothing. Press Enter or + to add."
      >
        <TagListEditor
          values={targeting.excludedCompanies}
          onChange={(v) => set('excludedCompanies', v)}
          placeholder="Acme Corp"
          transform={(s) => s.toLowerCase()}
        />
      </Field>

      <Field
        title="Excluded keywords"
        hint="Title/description keywords that disqualify a job. Empty = exclude nothing. Press Enter or + to add."
      >
        <TagListEditor
          values={targeting.excludedKeywords}
          onChange={(v) => set('excludedKeywords', v)}
          placeholder="unpaid"
          transform={(s) => s.toLowerCase()}
        />
      </Field>

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={save} disabled={isSaving || !isDirty}>
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save targeting
        </Button>
        <Button type="button" variant="ghost" onClick={resetAll} disabled={isSaving}>
          Clear all
        </Button>
      </div>
    </div>
  )
}
