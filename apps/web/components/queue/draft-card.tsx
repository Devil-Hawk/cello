'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Building2,
  Check,
  ExternalLink,
  FileText,
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

export interface DraftRow {
  id: string
  job_id: string
  resume_summary: string | null
  cover_letter: string | null
  answers: unknown
  status: 'pending_review' | 'approved' | 'submitted' | 'rejected' | 'failed'
  submission_ref: string | null
  created_at: string
  jobs?: JobRel | JobRel[] | null
}

const STATUS_TONE: Record<DraftRow['status'], 'good' | 'warn' | 'bad' | 'neutral' | 'accent'> = {
  pending_review: 'accent',
  approved: 'warn',
  submitted: 'good',
  rejected: 'neutral',
  failed: 'bad',
}

const STATUS_LABEL: Record<DraftRow['status'], string> = {
  pending_review: 'Pending review',
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
  const [busy, setBusy] = useState<null | 'save' | 'approve' | 'reject'>(null)

  const pending = draft.status === 'pending_review'
  const handoffUrl = handoffUrlFrom(draft.answers)

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
          {STATUS_LABEL[draft.status]}
        </Badge>
      </div>

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
        {pending && (
          <>
            <Button size="sm" onClick={approve} disabled={busy !== null || editing}>
              {busy === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              One-click apply
            </Button>
            <Button size="sm" variant="outline" onClick={reject} disabled={busy !== null}>
              {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              Reject
            </Button>
          </>
        )}
        {draft.status === 'approved' && handoffUrl && (
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
