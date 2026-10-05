'use client'

import { useEffect, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

// The facts a person states about roles they cannot or will not take. Cello hides
// a role only when its posting clearly breaks one of these, and says which. The
// shape is the one GET and PUT /api/settings/constraints speak.
interface Dealbreakers {
  blockedCountries: string[]
  onlyCountries: string[]
  onsiteCities: string[]
  needsSponsorship: boolean
  salaryFloorUsd: number | null
  remoteOnly: boolean
  excludedCompanies: string[]
  refusedSeniority: string[]
  excludedTitleWords: string[]
}

const LEVELS: { value: string; label: string }[] = [
  { value: 'intern', label: 'Intern' },
  { value: 'junior', label: 'Junior' },
  { value: 'senior', label: 'Senior' },
  { value: 'staff', label: 'Staff' },
  { value: 'principal', label: 'Principal' },
  { value: 'manager', label: 'Manager' },
  { value: 'director', label: 'Director' },
]

const EMPTY: Dealbreakers = {
  blockedCountries: [],
  onlyCountries: [],
  onsiteCities: [],
  needsSponsorship: false,
  salaryFloorUsd: null,
  remoteOnly: false,
  excludedCompanies: [],
  refusedSeniority: [],
  excludedTitleWords: [],
}

/** Tokens: type a value, press Enter or the plus button. */
function Tokens({ label, values, onChange, placeholder, transform = (s: string) => s }: { label: string; values: string[]; onChange: (next: string[]) => void; placeholder: string; transform?: (s: string) => string }) {
  const [draft, setDraft] = useState('')
  function commit() {
    const next = transform(draft.trim())
    if (!next) return
    if (!values.includes(next)) onChange([...values, next])
    setDraft('')
  }
  return (
    <div>
      <div className="flex gap-2">
        <Input
          aria-label={label}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={placeholder}
          className="h-11 sm:h-9"
        />
        <Button type="button" variant="outline" size="icon" onClick={commit} aria-label={`Add to ${label}`} className="h-11 w-11 sm:h-9 sm:w-9">
          <Plus className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-full border bg-sunken px-2 py-0.5 text-caption text-foreground">
              {v}
              <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border bg-card p-4">
      <p className="text-body font-medium text-foreground">{title}</p>
      {hint && <p className="mt-0.5 text-caption text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-body text-foreground sm:min-h-0">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 rounded border-input accent-[hsl(var(--accent))]" />
      {label}
    </label>
  )
}

/** Settings, Dealbreakers: the facts that keep a role off the list, each with the reason Cello will give. */
export function DealbreakersSection({ onStatus }: { onStatus: (status: 'success' | 'error', message: string) => void }) {
  const [value, setValue] = useState<Dealbreakers>(EMPTY)
  const [saved, setSaved] = useState<Dealbreakers>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/constraints')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { constraints: Dealbreakers }) => {
        if (cancelled) return
        setValue(data.constraints)
        setSaved(data.constraints)
      })
      .catch(() => !cancelled && setLoadFailed(true))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const set = <K extends keyof Dealbreakers>(key: K, v: Dealbreakers[K]) => setValue((prev) => ({ ...prev, [key]: v }))
  const dirty = JSON.stringify(value) !== JSON.stringify(saved)

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/settings/constraints', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
      const data = (await res.json().catch(() => ({}))) as { constraints?: Dealbreakers; error?: string }
      if (!res.ok || !data.constraints) {
        onStatus('error', data.error ?? 'Could not save your dealbreakers.')
      } else {
        setValue(data.constraints)
        setSaved(data.constraints)
        onStatus('success', 'Saved. Cello will re-check your roles.')
      }
    } catch {
      onStatus('error', 'Could not save your dealbreakers. Check your connection and try again.')
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-caption text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading your dealbreakers
      </div>
    )
  }
  if (loadFailed) return <p className="text-caption text-muted-foreground">Could not load your dealbreakers. Reload the page to try again.</p>

  return (
    <section className="space-y-4" aria-labelledby="dealbreakers-heading">
      <div>
        <h2 id="dealbreakers-heading" className="font-display text-section text-foreground">
          Dealbreakers
        </h2>
        <p className="mt-1 text-caption text-muted-foreground">Cello hides a role only when the posting clearly breaks one of these, and tells you which.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Row title="Countries you can work in" hint="Two-letter codes, like US. Empty means anywhere.">
          <Tokens label="Countries you can work in" values={value.onlyCountries} onChange={(v) => set('onlyCountries', v)} placeholder="US" transform={(s) => s.toUpperCase()} />
        </Row>
        <Row title="Countries you cannot work in">
          <Tokens label="Countries you cannot work in" values={value.blockedCountries} onChange={(v) => set('blockedCountries', v)} placeholder="DE" transform={(s) => s.toUpperCase()} />
        </Row>
        <Row title="Cities you can work on site in" hint="Remote roles are never affected.">
          <Tokens label="Cities you can work on site in" values={value.onsiteCities} onChange={(v) => set('onsiteCities', v)} placeholder="Seattle" transform={(s) => s.toLowerCase()} />
        </Row>
        <Row title="Lowest yearly pay (USD)" hint="Only applies when the posting states pay.">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            aria-label="Lowest yearly pay in US dollars"
            value={value.salaryFloorUsd ?? ''}
            onChange={(e) => set('salaryFloorUsd', e.target.value.trim() === '' ? null : Math.max(0, Math.round(Number(e.target.value))))}
            placeholder="No minimum"
            className="h-11 max-w-[12rem] sm:h-9"
          />
        </Row>
        <Row title="Companies to avoid">
          <Tokens label="Companies to avoid" values={value.excludedCompanies} onChange={(v) => set('excludedCompanies', v)} placeholder="Acme Corp" transform={(s) => s.toLowerCase()} />
        </Row>
        <Row title="Words that rule out a title">
          <Tokens label="Words that rule out a title" values={value.excludedTitleWords} onChange={(v) => set('excludedTitleWords', v)} placeholder="intern" transform={(s) => s.toLowerCase()} />
        </Row>
      </div>

      <Row title="Levels I will not take">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Levels I will not take">
          {LEVELS.map((l) => {
            const on = value.refusedSeniority.includes(l.value)
            return (
              <button
                key={l.value}
                type="button"
                aria-pressed={on}
                onClick={() => set('refusedSeniority', on ? value.refusedSeniority.filter((x) => x !== l.value) : [...value.refusedSeniority, l.value])}
                className={cn(
                  'min-h-11 rounded-full border px-3 py-1 text-caption transition-colors sm:min-h-0',
                  on ? 'border-primary bg-accent-soft text-accent-deep' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {l.label}
              </button>
            )
          })}
        </div>
      </Row>

      <div className="space-y-1 rounded-card border bg-card p-4">
        <Toggle label="I need visa sponsorship" checked={value.needsSponsorship} onChange={(v) => set('needsSponsorship', v)} />
        <Toggle label="Remote roles only" checked={value.remoteOnly} onChange={(v) => set('remoteOnly', v)} />
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={saving || !dirty} className="h-11 sm:h-9">
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Save dealbreakers
        </Button>
      </div>
    </section>
  )
}
