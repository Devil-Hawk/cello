'use client'

import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { COUNTRIES, LEVELS, roleTypeOptions, type WelcomeTargets } from '@/lib/welcome/commands.stub'
import { fitLine, typedTitle } from './logic'

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Key variant={on ? 'ink' : 'raised'} aria-pressed={on} onClick={onClick}>
      {children}
    </Key>
  )
}

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

// Screen 2: what you want. Role types from the list, or type a title and code
// names its type. The line under it is a count from code, never an estimate.
export function WantScreen({
  value,
  onChange,
  fit,
  saving,
  error,
  onDone,
}: {
  value: WelcomeTargets
  onChange: (next: WelcomeTargets) => void
  fit: number | null
  saving: boolean
  error: string | null
  onDone: () => void
}) {
  const types = roleTypeOptions()
  const [title, setTitle] = useState('')
  const typed = typedTitle(title)
  const line = fitLine(fit)

  return (
    <div className="space-y-8">
      <h2 className="r-section">What do you want</h2>

      <section className="space-y-3" aria-labelledby="want-types">
        <h3 id="want-types" className="r-title">
          Role types
        </h3>
        <div className="flex flex-wrap gap-2">
          {types.map((t) => (
            <Chip key={t.id} on={value.roleTypeIds.includes(t.id)} onClick={() => onChange({ ...value, roleTypeIds: toggle(value.roleTypeIds, t.id) })}>
              {t.label}
            </Chip>
          ))}
        </div>
        <div className="space-y-2">
          <label htmlFor="typed-title" className="r-meta">
            Or type a title
          </label>
          <input id="typed-title" className="r-field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Deployment Strategist" />
          {title.trim() && (
            <p className="r-body" aria-live="polite">
              {typed ? (
                <>
                  {typed.line}{' '}
                  <button
                    type="button"
                    className="inline-flex min-h-11 items-center underline underline-offset-4"
                    onClick={() => {
                      onChange({ ...value, roleTypeIds: value.roleTypeIds.includes(typed.id) ? value.roleTypeIds : [...value.roleTypeIds, typed.id] })
                      setTitle('')
                    }}
                  >
                    Use it
                  </button>
                </>
              ) : (
                <span className="text-r-ink-2">Cello cannot place that title yet. Pick the closest type above.</span>
              )}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="want-level">
        <h3 id="want-level" className="r-title">
          Level
        </h3>
        <div className="flex flex-wrap gap-2">
          {LEVELS.map((l) => (
            <Chip key={l.id} on={value.levelIds.includes(l.id)} onClick={() => onChange({ ...value, levelIds: toggle(value.levelIds, l.id) })}>
              {l.label}
            </Chip>
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="want-where">
        <h3 id="want-where" className="r-title">
          Where you can work
        </h3>
        <div className="flex flex-wrap gap-2">
          <Chip on={value.remoteOnly} onClick={() => onChange({ ...value, remoteOnly: !value.remoteOnly })}>
            Remote only
          </Chip>
          {COUNTRIES.map((c) => (
            <Chip key={c.code} on={value.countries.includes(c.code)} onClick={() => onChange({ ...value, countries: toggle(value.countries, c.code) })}>
              {c.label}
            </Chip>
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="want-out">
        <h3 id="want-out" className="r-title">
          Leave out
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="out-companies" className="r-meta">
              Companies, separated by commas
            </label>
            <input id="out-companies" className="r-field" defaultValue={value.excludedCompanies.join(', ')} onBlur={(e) => onChange({ ...value, excludedCompanies: list(e.target.value) })} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="out-words" className="r-meta">
              Words in a title, separated by commas
            </label>
            <input id="out-words" className="r-field" defaultValue={value.excludedWords.join(', ')} onBlur={(e) => onChange({ ...value, excludedWords: list(e.target.value) })} />
          </div>
        </div>
      </section>

      {line && (
        <p className="r-title" aria-live="polite">
          {line}
        </p>
      )}
      {error && (
        <p role="alert" className="r-body">
          {error}
        </p>
      )}
      <Key onClick={onDone} disabled={saving}>
        {saving ? 'Saving' : 'Next'}
      </Key>
    </div>
  )
}
