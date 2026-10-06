'use client'

// What Cello knows about you: one row per fact with its source and a Correct key.
// Correct saves the value as yours; the page decides where it is written.

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Fact } from './facts'

export interface FactsGroupProps {
  facts: Fact[]
  /** Saves a correction. Returns what went wrong, or null when it was saved. */
  onCorrect: (fact: Fact, raw: string) => Promise<string | null>
}

function FactRow({ fact, onCorrect }: { fact: Fact; onCorrect: FactsGroupProps['onCorrect'] }) {
  const [editing, setEditing] = useState(false)
  const [raw, setRaw] = useState(fact.raw)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const id = `fact-${fact.key}`

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const problem = await onCorrect(fact, raw)
    setSaving(false)
    setError(problem)
    if (!problem) setEditing(false)
  }

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-caption text-muted-foreground">{fact.label}</p>
          <p className="break-words text-body text-foreground">{fact.value}</p>
          <p className="text-caption text-muted-foreground">{fact.source}</p>
        </div>
        {fact.correct && !editing && (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 min-w-11"
            aria-label={`Correct ${fact.label.toLowerCase()}`}
            onClick={() => {
              setRaw(fact.raw)
              setError(null)
              setEditing(true)
            }}
          >
            Correct
          </Button>
        )}
      </div>
      {fact.correct && editing && (
        <form onSubmit={save} className="mt-2 flex flex-wrap items-start gap-2">
          <label htmlFor={id} className="sr-only">
            {fact.label}
          </label>
          {fact.correct.input === 'yesno' ? (
            <select id={id} value={raw} onChange={(e) => setRaw(e.target.value)} className="min-h-11 rounded-control border bg-card px-3 text-body">
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          ) : (
            <Input
              id={id}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              inputMode={fact.correct.input === 'number' ? 'numeric' : undefined}
              placeholder={fact.correct.input === 'list' ? 'Separate with commas' : undefined}
              className="min-h-11 w-full max-w-sm"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
            />
          )}
          <Button type="submit" className="min-h-11" disabled={saving}>
            {saving ? 'Saving' : 'Save'}
          </Button>
          <Button type="button" variant="ghost" className="min-h-11" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {error && (
            <p id={`${id}-error`} role="alert" className="w-full text-caption text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
    </li>
  )
}

export function FactsGroup({ facts, onCorrect }: FactsGroupProps) {
  return (
    <ul className="divide-y">
      {facts.map((f) => (
        <FactRow key={`${f.key}:${f.raw}:${f.value}`} fact={f} onCorrect={onCorrect} />
      ))}
    </ul>
  )
}
