'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Key } from '@/components/ui/key'
import { AddApplicationDialog, type NewApplication } from '@/components/pipeline/add-application-dialog'
import { ApplicationsView, ConfirmFound, type AppRow } from '@/components/pipeline/applications-view'
import type { FoundItem } from '@/lib/applications/found'
import { FindingsView } from '@/components/insights/findings'

// Applications: the list and the board of what has been sent or found, and Results (what is working).
export default function ApplicationsPage() {
  const results = useSearchParams().get('view') === 'results'
  const [rows, setRows] = useState<AppRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [found, setFound] = useState<FoundItem[]>([])
  const [gmailConnected, setGmailConnected] = useState(true)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      const [res, foundRes] = await Promise.all([fetch('/api/applications'), fetch('/api/applications/found').catch(() => null)])
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as { applications: AppRow[]; gmailConnected?: boolean }
      setRows(body.applications)
      setGmailConnected(body.gmailConnected !== false)
      setFound(foundRes?.ok ? ((await foundRes.json()) as { found: FoundItem[] }).found : [])
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

  async function add(a: NewApplication): Promise<string | null> {
    const res = await fetch('/api/applications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ add: a }) })
    const body = (await res.json().catch(() => ({}))) as { error?: string; existed?: boolean }
    if (!res.ok) return body.error ?? 'Could not add that.'
    setNote(body.existed ? 'You already had that one.' : 'Added.')
    await load()
    return null
  }

  async function confirm(f: FoundItem) {
    const res = await fetch('/api/applications/found', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.applicationId ? { applicationId: f.applicationId } : { messageId: f.messageId }) })
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    setNote(res.ok ? 'Confirmed.' : (body.error ?? 'Could not confirm that. Nothing changed.'))
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
              <Key variant="raised" onClick={() => setAdding(true)}>Add application</Key>
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
      {!results && !gmailConnected && rows && rows.some((r) => r.group) && (
        <section className="r-sheet space-y-3 p-6">
          <p className="r-body">Gmail is not connected, so applications you sent elsewhere are not here.</p>
          <div className="flex flex-wrap gap-2">
            <Key asChild><Link href="/settings?tab=connections">Connect Gmail</Link></Key>
            <Key variant="raised" onClick={() => setAdding(true)}>Add one by hand</Key>
          </div>
        </section>
      )}
      {results ? (
        <FindingsView />
      ) : error ? (
        <p className="r-body" role="alert">{error} <button type="button" className="underline" onClick={load}>Try again</button></p>
      ) : rows === null ? (
        <p className="r-meta">Reading.</p>
      ) : rows.filter((r) => r.group).length === 0 ? (
        <>
        <ConfirmFound found={found} onConfirm={confirm} />
        <section className="r-sheet space-y-3 p-6">
          <p className="r-body">No applications yet. Roles you apply to land here, and so do applications Cello finds in your email.</p>
          <div className="flex flex-wrap gap-2">
            <Key asChild><Link href="/roles">Open Roles</Link></Key>
            <Key asChild variant="raised"><Link href="/settings?tab=connections">Connect Gmail</Link></Key>
          </div>
        </section>
        </>
      ) : (
        <ApplicationsView rows={rows} onMove={move} found={found} onConfirmFound={confirm} />
      )}
      <AddApplicationDialog open={adding} onClose={() => setAdding(false)} onAdd={add} />
    </div>
  )
}
