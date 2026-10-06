'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Key } from '@/components/ui/key'
import { ApplicationsView, type AppRow } from '@/components/pipeline/applications-view'
import { FindingsView } from '@/components/insights/findings'

// Applications: the list and the board of what has been sent or found, and Results (what is working).
export default function ApplicationsPage() {
  const results = useSearchParams().get('view') === 'results'
  const [rows, setRows] = useState<AppRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/applications')
      if (!res.ok) throw new Error(String(res.status))
      setRows(((await res.json()) as { applications: AppRow[] }).applications)
      setError(null)
    } catch {
      setError('Could not load your applications. Try again.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function move(id: string, stage: string) {
    setNote(null)
    const res = await fetch(`/api/applications/${id}/stage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage }) })
    if (!res.ok) setNote('Could not move that. Nothing changed.')
    await load()
  }

  async function add() {
    const company = window.prompt('Company')?.trim()
    const title = company ? window.prompt('Job title')?.trim() : null
    if (!company || !title) return
    const res = await fetch('/api/applications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ add: { company, title } }) })
    setNote(res.ok ? 'Added.' : 'Could not add that.')
    await load()
  }

  async function importCsv(file: File) {
    const res = await fetch('/api/applications/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text() })
    setNote(res.ok ? 'Imported.' : 'Could not read that file.')
    await load()
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-8 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="r-display">Applications</h1>
        <div className="flex flex-wrap gap-2">
          <nav aria-label="Applications views" className="flex gap-2">
            <Key asChild variant={results ? 'raised' : 'ink'} current={!results}><Link href="/applications">Applications</Link></Key>
            <Key asChild variant={results ? 'ink' : 'raised'} current={results}><Link href="/applications?view=results">Results</Link></Key>
          </nav>
          {!results && (
            <>
              <Key variant="raised" onClick={add}>Add application</Key>
              <Key variant="raised" asChild>
                <label className="cursor-pointer">
                  Import CSV
                  <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} />
                </label>
              </Key>
              <Key variant="raised" asChild><a href="/api/applications/export.csv">Export CSV</a></Key>
            </>
          )}
        </div>
      </header>
      {note && <p className="r-meta" role="status">{note}</p>}
      {results ? (
        <FindingsView />
      ) : error ? (
        <p className="r-body" role="alert">{error} <button type="button" className="underline" onClick={load}>Try again</button></p>
      ) : rows === null ? (
        <p className="r-meta">Reading.</p>
      ) : rows.filter((r) => r.group).length === 0 ? (
        <section className="r-sheet space-y-3 p-6">
          <p className="r-body">No applications yet. Roles you apply to land here, and so do applications Cello finds in your email.</p>
          <div className="flex flex-wrap gap-2">
            <Key asChild><Link href="/roles">Open Roles</Link></Key>
            <Key asChild variant="raised"><Link href="/settings?tab=connections">Connect Gmail</Link></Key>
          </div>
        </section>
      ) : (
        <ApplicationsView rows={rows} onMove={move} />
      )}
    </div>
  )
}
