'use client'

// Fix company names: put the right name on a company a posting page named by its address. Kept from the old
// Settings (companies.fix_names); the route does the work and says how many it changed.

import { useState } from 'react'
import { Key } from '@/components/ui/key'

export function FixNamesCard() {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/companies/fix-names', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error()
      const n = typeof body.fixed === 'number' ? body.fixed : typeof body.updated === 'number' ? body.updated : null
      setNote(n === null ? 'Done.' : n === 0 ? 'Every company already has its right name.' : `Fixed ${n} ${n === 1 ? 'name' : 'names'}.`)
    } catch {
      setNote('Could not do that. Nothing changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="fix-names-h" className="r-sheet space-y-2 p-6">
      <h2 id="fix-names-h" className="r-title">Fix company names</h2>
      <p className="r-body">Some companies were saved under a web address. This puts the right name on each one.</p>
      <Key variant="raised" disabled={busy} onClick={run}>{busy ? 'Working' : 'Fix company names'}</Key>
      {note && <p className="r-meta" role="status">{note}</p>}
    </section>
  )
}
