'use client'

// Follow, Pin, Stop following and Check now on one row. Following a verified employer goes through
// companies.add (POST /api/companies/add) and then starts a read, so "Cello is reading its site now" is true. Every
// other change goes through the page's actions, which write through the one follow function.

import { Pin } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { setFollow, takeCheck } from '@/app/(app)/companies/actions'
import { addOutcome, failLine, type AddResponse, type CompanyItem } from './logic'
import { refreshCompanyJobs } from './refresh'

export interface RowActionsProps {
  item: Pick<CompanyItem, 'id' | 'companyId' | 'name' | 'following' | 'pinned' | 'cannotRead'>
  /** Following offers Check now and Stop following on the row. */
  manage?: boolean
}

export function RowActions({ item, manage = false }: RowActionsProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function follow() {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/companies/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employerId: item.id }) })
      const body = (await res.json().catch(() => null)) as AddResponse | null
      if (!body) {
        setNote(failLine('network', {}))
        return
      }
      const outcome = addOutcome(body, { name: item.name })
      setNote(outcome.kind === 'idle' || outcome.kind === 'verifying' ? null : outcome.line)
      if (body.ok) {
        // The read starts at once; the answer is not waited for.
        void refreshCompanyJobs(body.companyId)
        router.refresh()
      }
    } catch {
      setNote(failLine('network', {}))
    } finally {
      setBusy(false)
    }
  }

  async function change(c: { follow?: boolean; pin?: boolean }) {
    if (!item.companyId) return
    setBusy(true)
    setNote(null)
    try {
      const r = await setFollow(item.companyId, c)
      if (r.ok) router.refresh()
      else setNote(r.sentence)
    } catch {
      setNote(failLine('network', {}))
    } finally {
      setBusy(false)
    }
  }

  async function check() {
    if (!item.companyId) return
    setBusy(true)
    setNote(null)
    try {
      const r = await takeCheck(item.companyId)
      if (!r.ok) setNote(r.sentence)
      else {
        setNote('Cello is reading its site now.')
        await refreshCompanyJobs(item.companyId)
        router.refresh()
      }
    } catch {
      setNote(failLine('network', {}))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-none flex-wrap items-center gap-2">
      {item.following ? (
        <>
          {item.companyId && (
            <Key variant={item.pinned ? 'ink' : 'raised'} aria-pressed={item.pinned} aria-label={`${item.pinned ? 'Unpin' : 'Pin'} ${item.name}`} disabled={busy} onClick={() => change({ pin: !item.pinned })}>
              <Pin className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
            </Key>
          )}
          {manage && item.companyId && !item.cannotRead && (
            <Key variant="raised" disabled={busy} onClick={check}>
              Check now
            </Key>
          )}
          {manage && item.companyId ? (
            <Key variant="ghost" disabled={busy} onClick={() => change({ follow: false })}>
              Stop following
            </Key>
          ) : (
            <span className="r-meta px-2">Following</span>
          )}
        </>
      ) : (
        <Key variant="raised" aria-label={`Follow ${item.name}`} disabled={busy} onClick={follow}>
          Follow
        </Key>
      )}
      {note && (
        <p role="status" className="r-meta basis-full">
          {note}
        </p>
      )}
    </div>
  )
}
