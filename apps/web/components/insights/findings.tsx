'use client'

// What is working (blueprint 4.8): two lists, What is working and What is not, each line a finding with the counts
// behind it and the change Cello proposes. Keep confirms the proposal (it becomes a learning, section 9) and says
// where it acts; Not right dismisses it. Below a threshold the threshold's own sentence is shown, never a rate.

import { useEffect, useState } from 'react'
import { Key } from '@/components/ui/key'
import { findingsFrom, type Finding, type Findings as FindingsData } from '@/lib/strategy/findings'
import type { StrategyReport } from '@/lib/strategy/types'

const DISMISSED = 'cello:findings:dismissed'

// ponytail: a dismissed finding is remembered in this browser only; a stored dismissal arrives with results.get.
const readDismissed = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED) ?? '[]')
  } catch {
    return []
  }
}

function Line({ f, onKeep, onNotRight, kept }: { f: Finding; onKeep: (f: Finding) => void; onNotRight: (f: Finding) => void; kept: boolean }) {
  return (
    <li className="py-3">
      <p className="r-name">{f.line}</p>
      {f.proposal && (
        <>
          <p className="r-meta mt-1">{f.proposal.change}</p>
          {kept ? (
            <p className="r-meta mt-1">Kept. Cello will use this when it suggests and orders your roles. You can turn it off in Your search.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Key onClick={() => onKeep(f)}>Keep</Key>
              <Key variant="raised" onClick={() => onNotRight(f)}>Not right</Key>
            </div>
          )}
        </>
      )}
    </li>
  )
}

export function FindingsView() {
  const [findings, setFindings] = useState<FindingsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [kept, setKept] = useState<string[]>([])

  useEffect(() => {
    setDismissed(readDismissed())
    fetch('/api/strategy')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { report: StrategyReport }) => setFindings(findingsFrom(d.report)))
      .catch(() => setError('Could not read your results. Try again in a moment.'))
  }, [])

  async function keep(f: Finding) {
    if (!f.proposal) return
    const res = await fetch('/api/strategy/outcomes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalId: f.proposal.id, question: f.proposal.question, title: f.proposal.title }) })
    if (res.ok) setKept((k) => [...k, f.key])
    else setError('Could not keep that. Nothing changed.')
  }
  function notRight(f: Finding) {
    const next = [...dismissed, f.key]
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED, JSON.stringify(next))
    } catch {
      // a private window forgets it on reload; the page still hides it now
    }
  }

  if (error) return <p className="r-body" role="alert">{error}</p>
  if (!findings) return <p className="r-meta">Reading.</p>
  const show = (xs: Finding[]) => xs.filter((f) => !dismissed.includes(f.key))
  const working = show(findings.working)
  const notWorking = show(findings.notWorking)
  return (
    <div className="space-y-8">
      <section aria-labelledby="working-h" className="r-sheet p-6">
        <h2 id="working-h" className="r-title">What is working</h2>
        {working.length === 0 ? <p className="r-body mt-2">Nothing to say yet.</p> : <ul className="divide-y divide-[var(--r-line)]">{working.map((f) => <Line key={f.key} f={f} onKeep={keep} onNotRight={notRight} kept={kept.includes(f.key)} />)}</ul>}
      </section>
      <section aria-labelledby="not-h" className="r-sheet p-6">
        <h2 id="not-h" className="r-title">What is not</h2>
        {notWorking.length === 0 ? <p className="r-body mt-2">Nothing to say yet.</p> : <ul className="divide-y divide-[var(--r-line)]">{notWorking.map((f) => <Line key={f.key} f={f} onKeep={keep} onNotRight={notRight} kept={kept.includes(f.key)} />)}</ul>}
      </section>
      {findings.thresholds.length > 0 && (
        <ul className="space-y-1">{findings.thresholds.map((t) => <li key={t} className="r-meta">{t}</li>)}</ul>
      )}
    </div>
  )
}
