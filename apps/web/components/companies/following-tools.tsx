'use client'

// Check all now and Fix company names, on the Following tab. Both were on the old list and stay (directive 22).
// Check all now is limited to one an hour, like Check now. Fix company names is a quiet item until Settings holds
// it under Advanced (PG4).

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { takeCheck } from '@/app/(app)/companies/actions'
import { refreshViaAts } from './refresh'

export function FollowingTools({ canCheck }: { canCheck: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function checkAll() {
    setBusy(true)
    setNote(null)
    try {
      const r = await takeCheck('all')
      if (!r.ok) {
        setNote(r.sentence)
        return
      }
      const out = await refreshViaAts()
      setNote(`${out.totals.found} roles read, ${out.totals.inserted} new.`)
      router.refresh()
    } catch {
      setNote('Could not check your companies. Try again shortly.')
    } finally {
      setBusy(false)
    }
  }

  async function fixNames() {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/companies/fix-names', { method: 'POST' })
      const data = (await res.json()) as { success?: boolean; updates?: unknown[] }
      setNote(data.success ? `Fixed ${data.updates?.length ?? 0} company names.` : 'Could not fix names. Try again.')
      if (data.success) router.refresh()
    } catch {
      setNote('Could not fix names. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canCheck && (
        <Key variant="raised" disabled={busy} onClick={checkAll}>
          Check all now
        </Key>
      )}
      <Key variant="ghost" disabled={busy} onClick={fixNames}>
        Fix company names
      </Key>
      {note && (
        <p role="status" className="r-meta basis-full">
          {note}
        </p>
      )}
    </div>
  )
}
