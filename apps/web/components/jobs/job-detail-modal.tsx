'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Building2,
  FileEdit,
  Lightbulb,
  Loader2,
  MessageSquare,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PrepForInterviewButton } from '@/components/prep/prep-launcher'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { matchTone, type MatchTone } from '@/lib/format'
import { parseMatchDetails, type MatchDetails } from './match-badge'
import { MatchScoreBreakdown } from './match-score-breakdown'
import { ResumeOptimizerPanel } from '@/components/resume/resume-optimizer-panel'
import { JobProvenancePanel } from './job-provenance-panel'
import { ContactNetworkPanel } from '@/components/contacts/contact-network-panel'

interface JobWithCompany {
  id: string
  title: string
  description: string | null
  url: string
  location: string | null
  salary_range: string | null
  job_type: string | null
  posted_at: string | null
  match_score: number | null
  match_details: MatchDetails | string | null
  /** Present at runtime (jobs/page.tsx passes the full row); enables company research link. */
  company_id?: string | null
  companies: {
    name: string
    logo_url: string | null
    domain: string | null
  }
}

interface Insights {
  summary: string
  talkingPoints: string[]
  companyInsights: string[]
  interviewTips: string[]
}

/**
 * A failed insights request, kept as structured state rather than a bare
 * string so the panel can offer the RIGHT next step: retry when retrying
 * could work, Settings when the fix is a key or a resume.
 */
interface InsightsFailure {
  message: string
  /** Cause from /api/agents/analyze (`reason`), when it answered at all. */
  reason?: string
  retryable: boolean
  /** The fix lives in Settings — a missing/rejected key, or no resume. */
  needsSettings?: boolean
}

// Cache for storing insights by job ID. Successful analyses ONLY — a failure
// is never cached, or the user would be stuck re-reading the same error.
const insightsCache = new Map<string, Insights>()

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : []

/**
 * Defence in depth against an empty or half-built payload.
 *
 * The route now guarantees this (packages/agents refuses to return a
 * placeholder analysis), but this panel is where a regression would be
 * visible to a user as "AI insights loaded." above nothing — or, as it used
 * to be, above canned advice. If it isn't real, it isn't rendered.
 */
function toRenderableInsights(payload: unknown): Insights | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = payload as Record<string, unknown>
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  const insights: Insights = {
    summary,
    talkingPoints: strings(raw.talkingPoints),
    companyInsights: strings(raw.companyInsights),
    interviewTips: strings(raw.interviewTips),
  }
  const hasSection =
    insights.talkingPoints.length > 0 ||
    insights.companyInsights.length > 0 ||
    insights.interviewTips.length > 0
  return summary && hasSection ? insights : null
}

const TONE_TEXT: Record<MatchTone, string> = {
  good: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  muted: 'text-muted-foreground',
  bad: 'text-red-600 dark:text-red-400',
  none: 'text-muted-foreground',
}

export function JobDetailModal({
  job,
  onClose,
  hasResume,
  hasApiKey,
  apiKeyMessage,
  statusError,
  onRetryStatus,
}: {
  job: JobWithCompany
  onClose: () => void
  hasResume: boolean
  hasApiKey: boolean
  /** Precise "why no key" copy from /api/settings/status — see ResumeOptimizerPanel. */
  apiKeyMessage?: string | null
  /** Set when the account-status check itself failed — distinct from "missing resume/key". */
  statusError?: string | null
  /** Wired to retry the account-status fetch when statusError is set. */
  onRetryStatus?: () => void
}) {
  const [insights, setInsights] = useState<Insights | null>(insightsCache.get(job.id) || null)
  const [isLoadingInsights, setIsLoadingInsights] = useState(false)
  const [failure, setFailure] = useState<InsightsFailure | null>(null)

  // The element that had focus right before this modal opened — normally the
  // job row's "open details" button. Captured once, lazily, on first render
  // (this component only mounts once `open` becomes true, so `document.
  // activeElement` at that instant is still whatever the user just
  // activated). This Dialog is controlled externally (no <DialogTrigger> —
  // `open`/`onClose` live in the parent page's state), so Radix's own
  // close-focus-restore has no trigger ref to fall back to and silently
  // drops focus to <body> on Escape/close instead of returning it to the
  // triggering control. Restored explicitly via onCloseAutoFocus below.
  const [triggerElement] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  )

  async function getInsights() {
    // Check cache first
    if (insightsCache.has(job.id)) {
      setInsights(insightsCache.get(job.id)!)
      return
    }

    // Setup gaps, named precisely: "add a key" and "we couldn't even check
    // your account" are different problems with different next steps.
    if (statusError) {
      setFailure({
        message: "Couldn't check your account status, so insights weren't requested.",
        retryable: true,
      })
      return
    }

    if (!hasResume) {
      setFailure({
        message: 'Upload your resume in Settings — the analysis compares this job against it.',
        reason: 'no_resume',
        retryable: false,
        needsSettings: true,
      })
      return
    }

    if (!hasApiKey) {
      setFailure({
        message: apiKeyMessage ?? 'Add an API key in Settings to generate AI insights.',
        reason: 'no_api_key',
        retryable: false,
        needsSettings: true,
      })
      return
    }

    setIsLoadingInsights(true)
    setFailure(null)

    try {
      const response = await fetch('/api/agents/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      })

      // Read as text first: a platform timeout or gateway error answers with
      // HTML, and response.json() throwing would otherwise collapse every
      // distinct failure into one generic message.
      const rawText = await response.text()
      let data: Record<string, unknown> | null = null
      try {
        data = rawText ? JSON.parse(rawText) : null
      } catch {
        console.error('[job-detail-modal] non-JSON response', {
          status: response.status,
          body: rawText.slice(0, 500),
        })
        setFailure({
          message:
            response.status === 504
              ? 'The analysis timed out before the model answered — try again.'
              : `The analysis returned an unexpected response (HTTP ${response.status}).`,
          retryable: true,
        })
        return
      }

      if (!response.ok || typeof data?.error === 'string') {
        setFailure({
          message:
            typeof data?.error === 'string'
              ? data.error
              : `The analysis failed (HTTP ${response.status}).`,
          reason: typeof data?.reason === 'string' ? data.reason : undefined,
          // Default to retryable only for server-side faults: a 4xx we can't
          // classify won't fix itself on a second click.
          retryable: typeof data?.retryable === 'boolean' ? data.retryable : response.status >= 500,
          needsSettings: data?.needsKey === true || data?.budgetExhausted === true,
        })
        return
      }

      const renderable = toRenderableInsights(data)
      if (!renderable) {
        // Never announce insights we don't have. Showing an empty (or, as
        // this panel once did, a canned) analysis is worse than saying so.
        console.error('[job-detail-modal] analysis payload had nothing renderable', data)
        setFailure({
          message: 'The model returned an incomplete analysis for this job — try again.',
          reason: 'incomplete_response',
          retryable: true,
        })
        return
      }

      // Cache the result — successes only.
      insightsCache.set(job.id, renderable)
      setInsights(renderable)
    } catch (e) {
      console.error('[job-detail-modal] failed to get insights:', e)
      setFailure({
        message: e instanceof Error ? `Failed to get insights: ${e.message}` : 'Failed to get insights',
        retryable: true,
      })
    } finally {
      setIsLoadingInsights(false)
    }
  }

  const matchDetails = parseMatchDetails(job.match_details)
  const tone = matchTone(job.match_score)
  const meta = [job.location, job.salary_range, job.job_type].filter(Boolean) as string[]

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-w-2xl gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => {
          // Prevent Radix's default (`context.triggerRef.current?.focus()`,
          // a no-op here since there's no <DialogTrigger>) and restore focus
          // to the real trigger ourselves. Falls back to the browser default
          // (focus goes to <body>, same as an unhandled close) if nothing
          // was captured — e.g. this modal was opened some other way.
          if (triggerElement) {
            event.preventDefault()
            triggerElement.focus()
          }
        }}
      >
        {/* Header */}
        <DialogHeader className="border-b p-5 pr-12">
          <div className="flex items-center gap-3">
            {job.companies?.logo_url ? (
              <img
                src={job.companies.logo_url}
                alt=""
                className="h-10 w-10 shrink-0 rounded-control border bg-white object-contain p-1"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            ) : (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-sunken">
                <Building2 className="h-5 w-5 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0">
              <DialogTitle className="truncate">{job.title}</DialogTitle>
              <DialogDescription>{job.companies?.name}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="max-h-[60vh] overflow-y-auto">
          {meta.length > 0 && (
            <p className="px-5 pt-5 text-caption text-muted-foreground">{meta.join(' · ')}</p>
          )}

          {/* Where this came from — provenance, before the user invests in reading anything else */}
          <div className="border-t px-5 py-4 first:border-t-0">
            <h3 className="mb-2 text-body font-medium text-foreground">Where this came from</h3>
            <JobProvenancePanel jobId={job.id} />
          </div>

          {/* Match score section — career-ops-style: the overall number,
              broken into named sub-scores with an explicit rubric, every
              claim backed by evidence (strengths/gaps), not just a badge. */}
          {job.match_score !== null && (
            <div className="border-t px-5 py-4 first:border-t-0">
              <h3 className="mb-2 text-body font-medium text-foreground">Match analysis</h3>
              <div className={`font-display text-stat tabular-nums ${TONE_TEXT[tone]}`}>
                {job.match_score}% match
              </div>
              <div className="mt-3">
                <MatchScoreBreakdown score={job.match_score} details={matchDetails} />
              </div>
              {matchDetails?.skills?.matched && matchDetails.skills.matched.length > 0 && (
                <div className="mt-3 text-caption">
                  <span className="text-muted-foreground">Matched skills: </span>
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {matchDetails.skills.matched.join(', ')}
                  </span>
                </div>
              )}
              {matchDetails?.skills?.missing && matchDetails.skills.missing.length > 0 && (
                <div className="mt-1 text-caption">
                  <span className="text-muted-foreground">Skills to highlight: </span>
                  <span className="text-amber-600 dark:text-amber-400">
                    {matchDetails.skills.missing.join(', ')}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Resume ATS optimizer */}
          <div className="border-t px-5 py-4 first:border-t-0">
            <ResumeOptimizerPanel
              jobId={job.id}
              hasResume={hasResume}
              hasApiKey={hasApiKey}
              apiKeyMessage={apiKeyMessage}
              statusError={statusError}
              onRetryStatus={onRetryStatus}
            />
          </div>

          {/* Contacts, warm intros, and outreach drafting for this role */}
          {job.company_id && (
            <div className="border-t px-5 py-4 first:border-t-0">
              <ContactNetworkPanel companyId={job.company_id} jobId={job.id} variant="plain" />
            </div>
          )}

          {/* AI Insights */}
          <div className="border-t px-5 py-4 first:border-t-0">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-body font-medium text-foreground">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                AI insights
              </h3>
              {/* Hidden while a failure is on screen: that state carries its
                  own, correct affordance (retry vs. Settings) below. */}
              {!insights && !failure && (
                <Button onClick={getInsights} disabled={isLoadingInsights} size="sm">
                  {isLoadingInsights ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Analyzing…
                    </>
                  ) : (
                    'Get insights'
                  )}
                </Button>
              )}
            </div>

            {/* Announced once, briefly — the full insights panel below is too
                long to read aloud wholesale, but a screen reader user still
                needs to know the async load finished (and how). "Loaded" is
                said ONLY when there is a real analysis on screen: this line
                used to announce success over the canned fallback the API
                returned on failure. */}
            <p role="status" aria-live="polite" className="sr-only">
              {isLoadingInsights
                ? 'Loading AI insights…'
                : failure
                  ? `Could not load insights: ${failure.message}`
                  : insights
                    ? 'AI insights loaded.'
                    : ''}
            </p>

            {/* Failure state. Deliberately just the reason and a way forward —
                no bullet lists, no generic advice standing in for analysis. */}
            {failure && !isLoadingInsights && (
              <div className="rounded-control border border-red-200 bg-red-50/60 p-3 dark:border-red-500/30 dark:bg-red-500/10">
                <p className="text-caption text-red-700 dark:text-red-300">{failure.message}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      // A stale account-status check is its own retry: refresh
                      // that first, otherwise we'd just fail the same way.
                      if (statusError && onRetryStatus) {
                        setFailure(null)
                        onRetryStatus()
                        return
                      }
                      setFailure(null)
                      getInsights()
                    }}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Try again
                  </Button>
                  {failure.needsSettings && (
                    <Link
                      href="/settings"
                      className="text-caption font-medium text-accent-deep hover:underline"
                    >
                      Go to Settings
                    </Link>
                  )}
                </div>
              </div>
            )}

            {!insights && !failure && !isLoadingInsights && (
              <p className="text-caption text-muted-foreground">
                Get AI-powered insights about this job, including talking points, company
                information, and interview tips.
              </p>
            )}

            {insights && (
              <div className="space-y-4">
                {/* Summary */}
                <p className="text-caption text-muted-foreground">{insights.summary}</p>

                {/* Talking Points */}
                {insights.talkingPoints?.length > 0 && (
                  <div>
                    <h4 className="mb-2 flex items-center gap-2 text-body font-medium">
                      <MessageSquare className="h-4 w-4" />
                      Why you&apos;re a good fit
                    </h4>
                    <ul className="space-y-1 text-caption">
                      {insights.talkingPoints.map((point, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-muted-foreground">•</span>
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Company Insights */}
                {insights.companyInsights?.length > 0 && (
                  <div>
                    <h4 className="mb-2 flex items-center gap-2 text-body font-medium">
                      <Building2 className="h-4 w-4" />
                      About the company
                    </h4>
                    <ul className="space-y-1 text-caption">
                      {insights.companyInsights.map((insight, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-muted-foreground">•</span>
                          <span>{insight}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Interview Tips */}
                {insights.interviewTips?.length > 0 && (
                  <div>
                    <h4 className="mb-2 flex items-center gap-2 text-body font-medium">
                      <Lightbulb className="h-4 w-4" />
                      Interview prep
                    </h4>
                    <ul className="space-y-1 text-caption">
                      {insights.interviewTips.map((tip, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-muted-foreground">•</span>
                          <span>{tip}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Description */}
          {job.description && (
            <div className="border-t px-5 py-4 first:border-t-0">
              <h3 className="mb-2 text-body font-medium text-foreground">Job description</h3>
              <div className="whitespace-pre-wrap text-caption text-muted-foreground">
                {job.description}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap gap-2 border-t p-4">
          <Button className="flex-1" onClick={() => window.open(job.url, '_blank')}>
            Apply now
          </Button>
          <Button variant="outline" asChild>
            <Link href={`/resume/${job.id}`}>
              <FileEdit className="h-4 w-4" />
              Resume studio
            </Link>
          </Button>
          <PrepForInterviewButton jobId={job.id} />
          {job.company_id && (
            <Button variant="outline" asChild>
              <Link href={`/companies/${job.company_id}`}>
                <Building2 className="h-4 w-4" />
                Company research
              </Link>
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}
