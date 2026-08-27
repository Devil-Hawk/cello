'use client'

import { useEffect, useState } from 'react'
import { Building2, Clock, ClipboardCheck, Copy, FileCheck2, Loader2, Mail, MessageSquare, Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'
import { cn, formatRelativeTime } from '@/lib/utils'
import { formatShortDate, matchTone, STAGE_META, type PipelineStage } from '@/lib/format'
import { CompanyLogo } from '@/components/companies/company-logo'
import { PrepForInterviewButton } from '@/components/prep/prep-launcher'
import { LogApplicationDialog } from '@/components/pipeline/log-application-dialog'
import { PROVENANCE_LABELS } from '@/lib/applications/receipts'
import type { ApplicationActivity, ApplicationReceipt } from '@/lib/applications/types'
import {
  type ApplicationWithJob,
  getDaysSinceUpdate,
  getPipelineAlert,
  parseGmailInfo,
} from '@/components/pipeline/utils'

interface CoachSuggestion {
  suggestion: string
  draftMessage: string
  suggestedContacts?: string[]
}

interface ReceiptsResponse {
  receipts: ApplicationReceipt[]
  monitoring: { active: boolean; message: string }
  statusMessage: string
}

type ActivityTone = 'bad' | 'accent' | 'neutral'

const ACTIVITY_DOT_CLASS: Record<ActivityTone, string> = {
  bad: 'bg-red-500',
  // Accent is otherwise reserved for "new / attention" moments (see
  // components/ui/badge.tsx) — an interview signal earns it.
  accent: 'bg-accent',
  neutral: 'bg-muted-foreground/40',
}

function activityTone(type: string): ActivityTone {
  if (type === 'rejected') return 'bad'
  if (type.includes('interview')) return 'accent'
  return 'neutral'
}

/** "recruiter_screen" -> "Recruiter screen". Used only as the dot's tooltip
 *  — the row's own `title` (e.g. "Recruiter screen scheduled") already
 *  carries the human-readable story, so this isn't repeated as visible
 *  text. Derived rather than a static label table so an activity type
 *  neither this file nor lib/access/fixtures/pipeline.ts's DemoActivity
 *  anticipated still renders sensibly. */
function humanizeActivityType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** The real conversation history behind an application — see
 *  app/api/applications/activities/route.ts. Renders nothing at all when
 *  empty; the receipts block below already carries the honest "nothing on
 *  file" copy, so an empty timeline needs no empty-state box of its own. */
export function ActivityTimeline({ activities }: { activities: ApplicationActivity[] }) {
  if (activities.length === 0) return null

  return (
    <div className="border-t pt-4">
      <div className="mb-3 flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <span className="text-body font-medium text-foreground">Activity</span>
      </div>
      <ul className="space-y-3">
        {activities.map((activity) => (
          <li key={activity.id} className="flex gap-2.5">
            <span
              className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', ACTIVITY_DOT_CLASS[activityTone(activity.type)])}
              title={humanizeActivityType(activity.type)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="text-caption font-medium text-foreground">{activity.title}</span>
                <span className="shrink-0 text-caption text-muted-foreground">
                  {formatRelativeTime(activity.occurred_at)}
                </span>
              </div>
              {activity.description && (
                <p className="mt-0.5 text-caption text-muted-foreground">{activity.description}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-caption text-muted-foreground">{label}</span>
      <span className="min-w-0 text-body font-medium text-foreground">{children}</span>
    </div>
  )
}

function DialogBody({ application }: { application: ApplicationWithJob }) {
  const [coachSuggestion, setCoachSuggestion] = useState<CoachSuggestion | null>(null)
  const [isLoadingCoach, setIsLoadingCoach] = useState(false)
  const [coachError, setCoachError] = useState<string | null>(null)

  // The manual receipt path — see log-application-dialog.tsx. Loaded here so
  // the honest monitoring line and any receipts already on file are visible
  // without opening the logging form.
  const [receiptsData, setReceiptsData] = useState<ReceiptsResponse | null>(null)
  const [loadingReceipts, setLoadingReceipts] = useState(true)
  const [logDialogOpen, setLogDialogOpen] = useState(false)

  // The activity timeline — see app/api/applications/activities/route.ts.
  // Independent of the receipts fetch above: a stalled or failing receipts
  // load should never blank out activity history that already loaded fine.
  const [activities, setActivities] = useState<ApplicationActivity[]>([])

  function refreshReceipts() {
    setLoadingReceipts(true)
    fetch(`/api/applications/receipts?applicationId=${encodeURIComponent(application.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ReceiptsResponse | null) => setReceiptsData(data))
      .catch(() => setReceiptsData(null))
      .finally(() => setLoadingReceipts(false))
  }

  useEffect(() => {
    refreshReceipts()
    fetch(`/api/applications/activities?applicationId=${encodeURIComponent(application.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { activities: ApplicationActivity[] } | null) => setActivities(data?.activities ?? []))
      .catch(() => setActivities([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application.id])

  const job = application.jobs
  const company = job?.companies
  const daysSinceUpdate = getDaysSinceUpdate(application.updated_at)
  const alert = getPipelineAlert(application)
  const gmailInfo = parseGmailInfo(application.notes)
  const stageMeta = STAGE_META[application.stage as PipelineStage]
  const tone = matchTone(job?.match_score ?? null)

  const logoSrc =
    company?.logo_url ||
    (company?.domain
      ? `https://www.google.com/s2/favicons?domain=${company.domain}&sz=128`
      : null)

  async function getFollowUpDraft() {
    setIsLoadingCoach(true)
    setCoachError(null)
    try {
      const response = await fetch('/api/agents/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: application.id }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error || 'Failed to get coach suggestion')
      }
      setCoachSuggestion(result)
    } catch (e) {
      console.error('Failed to get coach suggestion:', e)
      setCoachError(e instanceof Error ? e.message : 'Failed to get coach suggestion')
    }
    setIsLoadingCoach(false)
  }

  return (
    <>
      {/* pr-8 keeps the title clear of DialogContent's absolutely-positioned
          close button, which sits at right-4 and was overlapping it. */}
      <DialogHeader className="pr-8">
        <div className="flex items-start gap-4">
          {logoSrc ? (
            <CompanyLogo src={logoSrc} name={company?.name || ''} className="h-12 w-12" />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-control border bg-sunken">
              <Building2 className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {/* Wraps rather than truncates. Real titles run long — "Junior
                Fullstack Engineer (m/w/d) - Festanstellung, Vollzeit" — and this
                is the primary identifier of the thing the dialog is about, so
                clipping it with an ellipsis loses the seniority and contract
                type a job seeker is reading it for. Two lines, then ellipsis. */}
            <DialogTitle className="line-clamp-2 break-words">
              {job?.title || 'Unknown Job'}
            </DialogTitle>
            <DialogDescription>{company?.name || 'Unknown Company'}</DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="space-y-3">
        <DetailRow label="Stage">
          <span className="inline-flex items-center gap-2">
            {stageMeta && <span className={cn('h-2 w-2 rounded-full', stageMeta.dotClass)} />}
            {stageMeta?.label ?? application.stage}
          </span>
        </DetailRow>

        <DetailRow label="Days in stage">
          <span className="inline-flex items-center gap-2 tabular-nums">
            {daysSinceUpdate}
            {alert && (
              <Badge tone={alert.kind === 'ghosted' ? 'bad' : 'warn'} title={alert.title}>
                {alert.label}
              </Badge>
            )}
          </span>
        </DetailRow>

        {tone !== 'none' && (
          <DetailRow label="Match score">
            <Badge tone={tone} className="tabular-nums">
              {job?.match_score}%
            </Badge>
          </DetailRow>
        )}

        {application.applied_at && (
          <DetailRow label="Applied">
            {new Date(application.applied_at).toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </DetailRow>
        )}

        {application.source && (
          <DetailRow label="Source">
            {application.source === 'gmail_sync' ? (
              <span className="inline-flex items-center gap-1.5">
                <Mail className="h-4 w-4 text-muted-foreground" />
                Gmail sync
              </span>
            ) : (
              <span className="capitalize">{application.source}</span>
            )}
          </DetailRow>
        )}

        {gmailInfo.subject && (
          <DetailRow label="Email subject">
            <span className="block max-w-[220px] truncate" title={gmailInfo.subject}>
              {gmailInfo.subject}
            </span>
          </DetailRow>
        )}

        {application.notes && !gmailInfo.threadUrl && !gmailInfo.subject && (
          <div>
            <span className="text-caption text-muted-foreground">Notes</span>
            <p className="mt-1 rounded-control bg-sunken p-2.5 text-body text-foreground">
              {application.notes}
            </p>
          </div>
        )}

        <ActivityTimeline activities={activities} />

        {/* Application receipt — works with zero Gmail access. A receipt is
            what Cello (or the applicant) actually witnessed, distinct from
            the pipeline stage above, which anyone can correct by hand
            regardless of whether a receipt exists. */}
        <div className="border-t pt-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
              <span className="text-body font-medium text-foreground">Application receipt</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => setLogDialogOpen(true)}>
              {receiptsData && receiptsData.receipts.length > 0 ? 'Add another' : 'I already applied'}
            </Button>
          </div>

          {loadingReceipts ? (
            <div className="flex items-center gap-2 py-2 text-caption text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              {receiptsData?.monitoring && (
                <p className="rounded-control bg-sunken/60 px-3 py-2 text-caption text-muted-foreground">
                  {receiptsData.statusMessage}
                </p>
              )}

              {receiptsData && receiptsData.receipts.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {receiptsData.receipts.map((receipt) => (
                    <li key={receipt.id} className="rounded-control border bg-card p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-caption font-medium text-foreground">
                          <FileCheck2 className="h-3.5 w-3.5 text-muted-foreground" />
                          {formatShortDate(receipt.submittedAt)}
                          {receipt.destination ? ` · ${receipt.destination}` : ''}
                        </span>
                        <Badge tone={receipt.verificationState === 'system_confirmed' ? 'good' : 'neutral'}>
                          {PROVENANCE_LABELS[receipt.provenance]}
                        </Badge>
                      </div>
                      {receipt.documents.length > 0 && (
                        <p className="mt-1 text-caption text-muted-foreground">
                          Resume: {receipt.documents.map((d) => d.label).join(', ')}
                        </p>
                      )}
                      {(receipt.confirmationIdentifier || receipt.confirmationNote) && (
                        <p className="mt-1 truncate text-caption text-muted-foreground">
                          {receipt.confirmationIdentifier && `#${receipt.confirmationIdentifier} `}
                          {receipt.confirmationNote}
                        </p>
                      )}
                      {receipt.confirmationAttachmentUrl && (
                        <span className="mt-1 inline-flex items-center gap-1 text-caption text-muted-foreground">
                          <Paperclip className="h-3 w-3" /> Screenshot attached
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/* Follow-up coach */}
        {['applied', 'screen', 'interview', 'offer'].includes(application.stage) && (
          <div className="border-t pt-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                <span className="text-body font-medium text-foreground">Follow-up coach</span>
              </div>
              {alert && (
                <Badge tone={alert.kind === 'ghosted' ? 'bad' : 'warn'}>{alert.title}</Badge>
              )}
            </div>

            {!coachSuggestion && !isLoadingCoach && (
              <Button variant="outline" size="sm" onClick={getFollowUpDraft} className="w-full">
                <MessageSquare className="h-4 w-4" />
                Get follow-up draft
              </Button>
            )}

            {isLoadingCoach && (
              <div className="flex items-center justify-center py-4 text-caption text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating follow-up draft…
              </div>
            )}

            {coachError && (
              <div className="border-l-2 border-red-400/60 bg-red-50/60 py-2 pl-3 text-caption text-red-700 dark:bg-red-500/5 dark:text-red-300">
                {coachError}
              </div>
            )}

            {coachSuggestion && (
              <div className="space-y-3">
                <p className="text-body font-medium text-foreground">
                  {coachSuggestion.suggestion}
                </p>

                <div className="relative">
                  <textarea
                    readOnly
                    value={coachSuggestion.draftMessage}
                    className="h-32 w-full resize-none rounded-control border bg-sunken p-3 text-body text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="absolute right-2 top-2"
                    onClick={() => {
                      navigator.clipboard.writeText(coachSuggestion.draftMessage)
                      toast({
                        title: 'Copied',
                        description: 'Message copied to clipboard',
                      })
                    }}
                  >
                    <Copy className="h-3 w-3" />
                    Copy
                  </Button>
                </div>

                {coachSuggestion.suggestedContacts &&
                  coachSuggestion.suggestedContacts.length > 0 && (
                    <div className="text-body">
                      <p className="font-medium text-foreground">
                        Suggested contacts to reach out to:
                      </p>
                      <ul className="mt-1 space-y-1">
                        {coachSuggestion.suggestedContacts.map((contact, i) => (
                          <li key={i} className="text-muted-foreground">
                            &#8226; {contact}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
              </div>
            )}
          </div>
        )}

        {/* Interview prep — surfaced once the candidate is in a live conversation */}
        {['screen', 'interview'].includes(application.stage) && job?.id && (
          <div className="border-t pt-4">
            <PrepForInterviewButton jobId={job.id} applicationId={application.id} />
          </div>
        )}
      </div>

      <DialogFooter>
        {gmailInfo.threadUrl && (
          <Button variant="outline" asChild>
            <a href={gmailInfo.threadUrl} target="_blank" rel="noopener noreferrer">
              <Mail className="h-4 w-4" />
              Open email
            </a>
          </Button>
        )}
        <Button asChild>
          <a href={job?.url} target="_blank" rel="noopener noreferrer">
            View job posting
          </a>
        </Button>
      </DialogFooter>

      <LogApplicationDialog
        open={logDialogOpen}
        onOpenChange={setLogDialogOpen}
        application={application}
        onLogged={refreshReceipts}
      />
    </>
  )
}

export interface ApplicationDetailDialogProps {
  application: ApplicationWithJob | null
  onClose: () => void
}

/** Application detail built on the B0 Dialog (focus trap + Escape close). */
export function ApplicationDetailDialog({ application, onClose }: ApplicationDetailDialogProps) {
  return (
    <Dialog open={Boolean(application)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        {application && <DialogBody key={application.id} application={application} />}
      </DialogContent>
    </Dialog>
  )
}
