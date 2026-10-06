'use client'

// Remove company, kept from the old page (directive 22). It removes the person's own row, never the employer from
// Companies. The confirm names, from counts read before anything is removed, what stays and what goes.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { removeCompany } from '@/app/(app)/companies/actions'
import { removeLines } from './company-logic'

export interface RemoveCompanyProps {
  companyId: string
  name: string
  counts: { applications: number; conversations: number; people: number; notes: boolean }
}

export function RemoveCompany({ companyId, name, counts }: RemoveCompanyProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const lines = removeLines(name, counts)

  async function remove() {
    setBusy(true)
    setNote(null)
    try {
      const r = await removeCompany(companyId)
      if (r.ok) router.push('/companies')
      else setNote(r.sentence)
    } catch {
      setNote('Could not remove that. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!open)
    return (
      <Key variant="ghost" onClick={() => setOpen(true)}>
        Remove company
      </Key>
    )
  return (
    <div role="group" aria-label={`Remove ${name}`} className="r-sheet space-y-3 p-4">
      <h2 className="r-title">{`Remove ${name}?`}</h2>
      <ul className="r-body space-y-1">
        {lines.stays.map((l) => (
          <li key={l}>{l}</li>
        ))}
        {lines.goes.map((l) => (
          <li key={l}>{l}</li>
        ))}
        <li>{`${name} stays in Companies.`}</li>
      </ul>
      {note && (
        <p role="alert" className="r-body">
          {note}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Key disabled={busy} onClick={remove}>
          Remove
        </Key>
        <Key variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Keep it
        </Key>
      </div>
    </div>
  )
}
