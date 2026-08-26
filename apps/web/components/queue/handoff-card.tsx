'use client'

// One row in the unmissable review queue: a company, a role, the ONE sentence
// saying why a human has to look at it, and the ONE action that resolves it.
//
// WHY A SINGLE ACTION, NOT A MENU
//   POST /api/drafts/approve already IS the single decision a human makes
//   here — "yes, send this" — and the server, not this component, decides
//   what happens next: an official-API submit when it can prove one is safe,
//   otherwise a prefilled handoff link (lib/ats-apply/index.ts). This card
//   never tries to predict which; it shows the reason, fires the one action,
//   and reacts to whichever outcome comes back — including opening the
//   handoff link itself, because a link the user has to go hunt for in
//   another tab is the exact "silent stall" this queue exists to prevent.

import { useState } from 'react'
import { Building2, ExternalLink, Loader2, MapPin, Send, X } from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { toast } from '@/components/ui/use-toast'
import { formatRelativeTime } from '@/lib/utils'
import type { ReviewQueueItem } from '@/lib/notifications/queue'

export type { ReviewQueueItem } from '@/lib/notifications/queue'

/** What POST /api/drafts/approve reports back. */
interface ApproveResponse {
  ok?: boolean
  status?: 'submitted' | 'approved' | 'failed'
  handoffUrl?: string | null
  provider?: string | null
  error?: string
}

export interface HandoffCardProps {
  item: ReviewQueueItem
  /** Called after ANY resolving action (approve or reject) succeeds, so the
   *  caller can refetch — the item's status has changed and this card no
   *  longer belongs in a pending-only list. */
  onResolved: () => void
}

/** pass/fail/unjudged chip — same Badge-tone idiom components/queue/
 *  outreach-card.tsx's JudgeVerdictRow already uses for eval_verdicts.
 *  Absent entirely (not an "unjudged" badge) when this draft has no verdict
 *  row at all yet — "never judged" and "judged, refused to score" are
 *  different facts, see ReviewQueueItem.verdict's own doc. */
function VerdictBadge({ verdict }: { verdict: NonNullable<ReviewQueueItem['verdict']> }) {
  const tone: BadgeTone = verdict === 'pass' ? 'good' : verdict === 'fail' ? 'bad' : 'muted'
  const label = verdict === 'pass' ? 'Verdict: pass' : verdict === 'fail' ? 'Verdict: fail' : 'Unjudged'
  return (
    <Badge tone={tone} className="shrink-0">
      {label}
    </Badge>
  )
}

export function HandoffCard({ item, onResolved }: HandoffCardProps) {
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null)

  async function approve() {
    setBusy('approve')
    try {
      const res = await fetch('/api/drafts/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: item.draftId }),
      })
      const data = (await res.json().catch(() => ({}))) as ApproveResponse
      if (!res.ok) throw new Error(data.error ?? 'Could not resolve this application.')

      if (data.status === 'submitted') {
        toast({ title: 'Application submitted', description: `via ${data.provider ?? 'the employer\'s ATS'}` })
      } else if (data.status === 'approved' && data.handoffUrl) {
        // The single action resolving to "open the link", not "go find it
        // yourself later" — see this file's header.
        toast({ title: 'Opening the prefilled application…', description: 'Finish it in the new tab.' })
        window.open(data.handoffUrl, '_blank', 'noopener,noreferrer')
      } else if (data.status === 'failed') {
        toast({
          title: 'Could not submit',
          description: data.error ?? 'Left in your queue — nothing was sent.',
          variant: 'destructive',
        })
      } else {
        toast({ title: 'Resolved', description: 'Left as a handoff for you to finish.' })
      }
      onResolved()
    } catch (err) {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed',
        variant: 'destructive',
      })
    } finally {
      setBusy(null)
    }
  }

  async function reject() {
    setBusy('reject')
    try {
      const res = await fetch('/api/drafts/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: item.draftId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Reject failed')
      toast({ title: 'Draft rejected' })
      onResolved()
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const busyNow = busy !== null

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-body font-semibold text-foreground">{item.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Building2 className="h-3 w-3" />
              {item.companyName}
            </span>
            {item.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {item.location}
              </span>
            )}
            <span>{formatRelativeTime(item.createdAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {/* Accent: this is a live, needs-you-now signal, the same
              vocabulary notification-bell.tsx uses for a genuinely
              actionable item. */}
          <Badge tone="accent" className="shrink-0">
            {item.mode === 'submit' ? 'Ready to submit' : 'Needs a handoff'}
          </Badge>
          {item.verdict && <VerdictBadge verdict={item.verdict} />}
        </div>
      </div>

      {/* THE WHY. Every item shows one, always — this is the field DraftCard
          never had, and its absence is what made a pile of handoffs read as
          "just pending" instead of "here is what's stopping each one". */}
      <p className="mt-3 rounded-control bg-sunken/60 p-3 text-caption text-foreground">{item.reason}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={approve} disabled={busyNow}>
          {busy === 'approve' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : item.mode === 'submit' ? (
            <Send className="h-3.5 w-3.5" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )}
          {item.mode === 'submit' ? 'Approve & submit' : 'Approve & open link'}
        </Button>
        <Button size="sm" variant="outline" onClick={reject} disabled={busyNow}>
          {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Reject
        </Button>
        {item.jobUrl && (
          <a
            href={item.jobUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-caption text-accent-deep underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            View role
          </a>
        )}
      </div>
    </Card>
  )
}
