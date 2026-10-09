'use client'

// Apply on one role in an employer's list. A role Cello kept already has a record; any other is kept now (keepPreview
// stores it once, for this person) and then the application is started. It stops at "approve" before anything is sent.

import Link from 'next/link'
import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { keepPreview } from '@/app/(app)/companies/actions'
import { startApplication } from '@/components/roles/start-application'

export function RowApply({ jobId, employerId, postingKey, title }: { jobId: string | null; employerId: string; postingKey: string; title: string }) {
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle')
  const [note, setNote] = useState<string | null>(null)

  async function apply() {
    setState('working')
    setNote(null)
    let id = jobId
    if (!id) {
      const kept = await keepPreview(employerId, postingKey, 'keep').catch(() => null)
      if (!kept?.ok) {
        setNote(kept?.sentence ?? 'Could not save that. Try again.')
        return setState('idle')
      }
      id = kept.id
    }
    const r = await startApplication(id)
    if (!r.ok) {
      setNote(r.sentence)
      return setState('idle')
    }
    setState('done')
  }

  if (state === 'done')
    return (
      <p role="status" className="r-meta basis-full sm:basis-auto">
        Application started. It stops before anything is sent.{' '}
        <Link href="/applications" className="underline underline-offset-4">
          See it in Applications
        </Link>
      </p>
    )
  return (
    <div className="flex flex-none flex-col items-start gap-1">
      <Key variant="raised" aria-label={`Apply to ${title}`} disabled={state === 'working'} onClick={apply}>
        {state === 'working' ? 'Starting' : 'Apply'}
      </Key>
      {note && (
        <p role="alert" className="r-meta">
          {note}
        </p>
      )}
    </div>
  )
}
