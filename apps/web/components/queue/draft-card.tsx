'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  Building2,
  Camera,
  Check,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  MapPin,
  Pencil,
  Send,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { formatShortDate } from '@/lib/format'

interface JobRel {
  id: string
  title: string
  url: string | null
  location: string | null
  companies?: { name: string | null } | { name: string | null }[] | null
}

export interface DraftScreenshot {
  page: string
  dataUrl: string
  capturedAt?: string
}

export interface DraftRow {
  id: string
  job_id: string
  resume_summary: string | null
  cover_letter: string | null
  answers: unknown
  status: 'pending_review' | 'filling' | 'approved' | 'submitted' | 'rejected' | 'failed'
  submission_ref: string | null
  created_at: string
  jobs?: JobRel | JobRel[] | null
  /** Set once a browser fill run has reported back (PATCH /api/apply/state).
   *  Its presence is what this card uses to tell an assisted-apply draft
   *  apart from an official-API one — see app/api/drafts/approve/route.ts. */
  fill_state?: { answers?: Record<string, string>; pagesVisited?: string[]; deviation?: { detail: string } } | null
  screenshots?: DraftScreenshot[] | null
  review_confirmed_at?: string | null
}

const STATUS_TONE: Record<DraftRow['status'], 'good' | 'warn' | 'bad' | 'neutral' | 'accent'> = {
  pending_review: 'accent',
  filling: 'accent',
  approved: 'warn',
  submitted: 'good',
  rejected: 'neutral',
  failed: 'bad',
}

const STATUS_LABEL: Record<DraftRow['status'], string> = {
  pending_review: 'Pending review',
  filling: 'Filling…',
  approved: 'Handoff ready',
  submitted: 'Submitted',
  rejected: 'Rejected',
  failed: 'Failed',
}

function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

function handoffUrlFrom(answers: unknown): string | null {
  const a = (answers ?? {}) as Record<string, unknown>
  const url = a.prefilledUrl ?? a.handoffUrl ?? a.applyUrl
  return typeof url === 'string' ? url : null
}

export function DraftCard({ draft, onChanged }: { draft: DraftRow; onChanged: () => void }) {
  const job = one(draft.jobs)
  const company = one(job?.companies)
  const [editing, setEditing] = useState(false)
  const [coverLetter, setCoverLetter] = useState(draft.cover_letter ?? '')
  const [busy, setBusy] = useState<null | 'save' | 'approve' | 'reject' | 'fill' | 'confirm'>(null)

  const pending = draft.status === 'pending_review'
  const handoffUrl = handoffUrlFrom(draft.answers)
  // Presence of fill_state is what tells an assisted-apply draft (a real
  // browser filled the hosted form) apart from an official-API one — see
  // app/api/drafts/approve/route.ts, the same signal it branches on.
  const assisted = Boolean(draft.fill_state)
  const filledAnswers = draft.fill_state?.answers ?? null
  const deviation = draft.fill_state?.deviation ?? null
  const screenshots = draft.screenshots ?? []

  async function fillWithBrowser() {
    setBusy('fill')
    try {
      const res = await fetch('/api/apply/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: draft.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not start the browser run')
      toast({ title: 'Browser run started', description: 'A real browser is filling this application — check back shortly.' })
      onChanged()
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  async function submitViaBrowser() {
    setBusy('confirm')
    try {
      const res = await fetch('/api/apply/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: draft.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not start the submit run')
      toast({ title: 'Submitting…', description: 'The browser is re-verifying and sending your application.' })
      onChanged()
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  async function save() {
    setBusy('save')
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cover_letter: coverLetter }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      setEditing(false)
      toast({ title: 'Draft saved' })
      onChanged()
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  async function approve() {
    setBusy('approve')
    try {
      const res = await fetch('/api/drafts/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: draft.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Apply failed')
      if (data.status === 'submitted') {
        toast({ title: 'Application submitted', description: `via ${data.provider ?? 'ATS'}` })
      } else if (data.status === 'approved' && data.assisted) {
        toast({ title: 'Reviewed answers approved', description: 'Click Submit application when you’re ready to send it.' })
      } else if (data.status === 'approved') {
        toast({ title: 'Handoff ready', description: 'Open the prefilled link to finish applying.' })
      } else {
        toast({ title: 'Could not submit', description: 'Left as a handoff.', variant: 'destructive' })
      }
      onChanged()
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
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
        body: JSON.stringify({ draftId: draft.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Reject failed')
      toast({ title: 'Draft rejected' })
      onChanged()
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-body font-semibold text-foreground">
            {job?.title ?? 'Application draft'}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
            {company?.name && (
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                {company.name}
              </span>
            )}
            {job?.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {job.location}
              </span>
            )}
            <span>{formatShortDate(draft.created_at)}</span>
          </div>
        </div>
        <Badge tone={STATUS_TONE[draft.status]} className="shrink-0">
          {draft.status === 'approved' && assisted ? 'Ready to submit' : STATUS_LABEL[draft.status]}
        </Badge>
      </div>

      {draft.status === 'filling' && (
        <p className="mt-3 flex items-center gap-1.5 rounded-control bg-sunken/60 px-3 py-2 text-caption text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          A real browser is filling out this application. Check back shortly — nothing is sent until you review and approve it.
        </p>
      )}

      {deviation && (
        <p className="mt-3 flex items-start gap-1.5 rounded-control bg-red-50 px-3 py-2 text-caption text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          The live form changed since you approved it, so nothing was sent: {deviation.detail} Review and approve again to retry.
        </p>
      )}

      {assisted && filledAnswers && Object.keys(filledAnswers).length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1.5 text-label uppercase text-muted-foreground">
            <Globe className="h-3 w-3" /> Filled by browser — answers
          </div>
          <dl className="max-h-40 overflow-y-auto rounded-control bg-sunken/60 p-3 text-caption">
            {Object.entries(filledAnswers).map(([field, value]) => (
              <div key={field} className="flex gap-2 py-0.5">
                <dt className="shrink-0 text-muted-foreground">{field}:</dt>
                <dd className="min-w-0 truncate text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {assisted && (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1.5 text-label uppercase text-muted-foreground">
            <Camera className="h-3 w-3" /> Screenshots ({screenshots.length})
          </div>
          {screenshots.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {screenshots.map((s) => (
                <a key={s.page} href={s.dataUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data: URLs, not a Next-optimizable remote image */}
                  <img
                    src={s.dataUrl}
                    alt={`Filled form — ${s.page}`}
                    className="h-24 w-32 rounded-control border object-cover object-top"
                  />
                </a>
              ))}
            </div>
          ) : (
            <p className="text-caption italic text-muted-foreground">No screenshots were captured for this run.</p>
          )}
        </div>
      )}

      {draft.resume_summary && (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1.5 text-label uppercase text-muted-foreground">
            <FileText className="h-3 w-3" /> Resume summary
          </div>
          <p className="line-clamp-3 whitespace-pre-wrap text-caption text-muted-foreground">
            {draft.resume_summary}
          </p>
        </div>
      )}

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-label uppercase text-muted-foreground">Cover letter</span>
          {pending && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 text-caption text-accent-deep hover:underline"
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={coverLetter}
              onChange={(e) => setCoverLetter(e.target.value)}
              className="min-h-[160px] text-caption"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCoverLetter(draft.cover_letter ?? '')
                  setEditing(false)
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p
            className={cn(
              'max-h-40 overflow-y-auto whitespace-pre-wrap rounded-control bg-sunken/60 p-3 text-caption text-foreground',
              !draft.cover_letter && 'italic text-muted-foreground'
            )}
          >
            {draft.cover_letter || 'No cover letter generated.'}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {pending && assisted && (
          <>
            <Button size="sm" onClick={approve} disabled={busy !== null || editing}>
              {busy === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Approve reviewed answers
            </Button>
            <Button size="sm" variant="outline" onClick={reject} disabled={busy !== null}>
              {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              Reject
            </Button>
          </>
        )}
        {pending && !assisted && (
          <>
            <Button size="sm" onClick={approve} disabled={busy !== null || editing}>
              {busy === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              One-click apply
            </Button>
            <Button size="sm" variant="outline" onClick={fillWithBrowser} disabled={busy !== null || editing}>
              {busy === 'fill' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
              Fill with browser
            </Button>
            <Button size="sm" variant="outline" onClick={reject} disabled={busy !== null}>
              {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              Reject
            </Button>
          </>
        )}
        {draft.status === 'approved' && assisted && (
          <Button size="sm" onClick={submitViaBrowser} disabled={busy !== null}>
            {busy === 'confirm' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Submit application
          </Button>
        )}
        {draft.status === 'approved' && !assisted && handoffUrl && (
          <Button size="sm" asChild>
            <a href={handoffUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" /> Finish on ATS
            </a>
          </Button>
        )}
        {job?.url && (
          <Button size="sm" variant="ghost" asChild>
            <Link href={job.url} target="_blank" rel="noopener noreferrer">
              View role
            </Link>
          </Button>
        )}
      </div>
    </Card>
  )
}
