'use client'

// What is working (blueprint 4.8): two lists, What is working and What is not, each line a finding with the counts
// behind it. Where Cello has a change to propose, Keep stores the person's choice and says where it acts, and Not
// right stores that it is not right, so the finding is gone next time. Then what Cello noticed, where your roles come
// from and how your roles spread, each with See them where Roles can filter by it. Below a threshold the threshold's
// own sentence is shown, never a rate. Every number is counted by code.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Key } from '@/components/ui/key'
import { callCommand } from '@/lib/network/client'
import type { GroupRow, ResultsView, ViewFinding } from '@/lib/strategy/results'

const DOOR = '/api/strategy/results'

function Line({ f, busy, onKeep, onNotRight }: { f: ViewFinding; busy: boolean; onKeep: (f: ViewFinding) => void; onNotRight: (f: ViewFinding) => void }) {
  return (
    <li className="py-3">
      <p className="r-name">{f.line}</p>
      {f.change && f.state === 'new' && (
        <>
          <p className="r-meta mt-1">{f.change}. If you keep it, it changes: {f.acts}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Key disabled={busy} onClick={() => onKeep(f)}>Keep</Key>
            <Key variant="raised" disabled={busy} onClick={() => onNotRight(f)}>Not right</Key>
          </div>
        </>
      )}
      {f.change && f.state === 'kept' && (
        <p className="r-meta mt-1">
          Kept: {f.change}. It changes: {f.acts} Turn it off in <Link href="/search" className="underline">Your search</Link>, under What Cello learned.
        </p>
      )}
    </li>
  )
}

function List({ id, title, empty, items, ...rest }: { id: string; title: string; empty: string; items: ViewFinding[]; busy: boolean; onKeep: (f: ViewFinding) => void; onNotRight: (f: ViewFinding) => void }) {
  return (
    <section aria-labelledby={id} className="r-sheet p-6">
      <h2 id={id} className="r-title">{title}</h2>
      {items.length === 0 ? <p className="r-body mt-2">{empty}</p> : <ul className="divide-y divide-[var(--r-line)]">{items.map((f) => <Line key={f.key} f={f} {...rest} />)}</ul>}
    </section>
  )
}

function Groups({ id, title, rows }: { id: string; title: string; rows: GroupRow[] }) {
  if (rows.length === 0) return null
  return (
    <section aria-labelledby={id} className="r-sheet p-6">
      <h2 id={id} className="r-title">{title}</h2>
      <ul className="divide-y divide-[var(--r-line)]">
        {rows.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
            <p className="r-name min-w-0 flex-1 basis-56">{g.label}</p>
            <p className="r-body">{g.n} {g.n === 1 ? 'role' : 'roles'}</p>
            {g.href && <Key asChild variant="raised"><Link href={g.href}>See them</Link></Key>}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The page as the person reads it. Pure over its props, so each state has a fixture. */
export function ResultsPanel({ view, busy = false, error, onKeep, onNotRight }: { view: ResultsView; busy?: boolean; error?: string | null; onKeep: (f: ViewFinding) => void; onNotRight: (f: ViewFinding) => void }) {
  const act = { busy, onKeep, onNotRight }
  return (
    <div className="space-y-8">
      {error && <p className="r-body" role="alert">{error}</p>}
      <List id="working-h" title="What is working" empty="Nothing to say yet." items={view.working} {...act} />
      <List id="not-h" title="What is not" empty="Nothing to say yet." items={view.notWorking} {...act} />
      {view.noticed.length > 0 && <List id="noticed-h" title="Cello noticed" empty="" items={view.noticed} {...act} />}
      <Groups id="source-h" title="Where your roles come from" rows={view.source} />
      <Groups id="spread-h" title="How your roles spread" rows={view.spread} />
      {view.thresholds.length > 0 && <ul className="space-y-1">{view.thresholds.map((t) => <li key={t} className="r-meta">{t}</li>)}</ul>}
    </div>
  )
}

export function FindingsView() {
  const [view, setView] = useState<ResultsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setView(await callCommand<ResultsView>(DOOR, 'results.get'))
      setError(null)
    } catch {
      setError('Could not read your results. Try again in a moment.')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function choose(command: 'proposals.confirm' | 'proposals.dismiss', f: ViewFinding) {
    setBusy(true)
    try {
      await callCommand(DOOR, command, { key: f.key })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that. Nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  if (!view) return error ? <p className="r-body" role="alert">{error}</p> : <p className="r-meta">Reading.</p>
  return <ResultsPanel view={view} busy={busy} error={error} onKeep={(f) => choose('proposals.confirm', f)} onNotRight={(f) => choose('proposals.dismiss', f)} />
}
