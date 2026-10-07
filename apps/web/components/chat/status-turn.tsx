'use client'

// One line in the conversation when an application the chat holds moves or finishes a step: the sentence the pipeline
// wrote for the event and the buttons its record would show. Nothing here comes from a model. An approval asked for
// shows Review (the tailored version opens beside the chat) and Approve; Approve is the person's own click, sent through
// their session, and appears only while the application still waits on it.

import { useState } from 'react'
import Link from 'next/link'
import { chatHref } from '@/lib/chat/links'
import type { StatusLine } from '@/lib/chat/status'

const BUTTON = 'rounded-control border border-border bg-card px-2 py-0.5 text-foreground hover:bg-muted disabled:opacity-40'

export function StatusTurn({ line, onReview, onApproved }: { line: StatusLine | undefined; onReview?: (artifactId: string) => void; onApproved?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!line) return null
  const href = chatHref('application', line.applicationId)
  const approval = line.approval
  async function approve() {
    if (!approval) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/applications/${encodeURIComponent(line!.applicationId)}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: approval.hash }) })
      if (!res.ok) setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Cello could not record that. Try again.')
      else onApproved?.()
    } catch {
      setError('Cello could not record that. Try again.')
    }
    setBusy(false)
  }
  return (
    <div className="space-y-1 border-l-2 border-border pl-3 text-caption text-muted-foreground" data-status-turn>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-foreground">{line.sentence}</span>
        {approval && onReview && (
          <button type="button" className={BUTTON} onClick={() => onReview(approval.artifactId)}>
            Review
          </button>
        )}
        {approval && (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void approve()}>
            Approve
          </button>
        )}
        {href && (
          <Link href={href} className={BUTTON}>
            Open
          </Link>
        )}
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
