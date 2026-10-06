'use client'

// The record after acting, group one: the application (4.6). Where it stands, in one sentence, and what the
// person can do next. Reads the person's own application for this role; nothing here sends anything.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { statusSentence } from '@/lib/pipeline/states'
import { CLOSED_LABEL } from '@/components/pipeline/applications-view'

interface Row {
  id: string
  stage: string
  state: string | null
  step: string | null
  needs_reason: string | null
  needs_detail: Record<string, unknown> | null
  applied_at: string | null
  closed_reason: string | null
}

export function ApplicationGroup({ jobId }: { jobId: string }) {
  const [row, setRow] = useState<Row | null | undefined>(undefined)

  useEffect(() => {
    createClient()
      .from('applications')
      .select('id, stage, state, step, needs_reason, needs_detail, applied_at, closed_reason')
      .eq('job_id', jobId)
      .maybeSingle()
      .then(({ data }) => setRow((data as Row | null) ?? null))
  }, [jobId])

  if (!row) return null
  const sentence = statusSentence({ state: row.state as never, step: row.step, needsReason: row.needs_reason as never, needsDetail: row.needs_detail }, 'The employer')
  return (
    <section aria-labelledby="after-app" className="r-sheet space-y-2 p-6">
      <h2 id="after-app" className="r-title">Application</h2>
      <p className="r-body">{row.closed_reason ? `Closed: ${CLOSED_LABEL[row.closed_reason] ?? row.closed_reason}.` : sentence || (row.stage === 'applied' ? 'Applied.' : `Stage: ${row.stage}.`)}</p>
      {row.applied_at && <p className="r-meta">Applied {new Date(row.applied_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.</p>}
      <Link href="/applications" className="r-meta underline">All applications</Link>
    </section>
  )
}
