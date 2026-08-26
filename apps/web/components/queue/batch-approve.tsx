'use client'

// The morning review: approve many prepared applications in one pass.
//
// WHY THIS IS THE FEATURE AND NOT A CONVENIENCE
//   Autopilot runs overnight and leaves a pile of complete, tailored
//   pending_review drafts. Clicking through fifty of them one at a time is the
//   same drudgery Cello exists to remove — so the batch review is the product,
//   not a shortcut around it.
//
// THE THREE THINGS THIS SURFACE HAS TO GET RIGHT
//   1. NOTHING IS SELECTED UNTIL THE USER ACTS. An interface that opens with
//      fifty pre-ticked irreversible actions is a trap, and one stray click
//      away from applying to fifty companies nobody chose. `selected` starts
//      empty and is emptied again on every reload, because a tick made against
//      a list that has since changed underneath the user is not consent for
//      whatever occupies that row now.
//   2. ITEMS NEEDING A HUMAN ARE NOT SELECTABLE AT ALL. They render in a
//      separate list that has no checkboxes in it — not disabled ones, none.
//      The server decides which list an item is in (see
//      app/api/drafts/batch-approve/eligibility.ts) and re-decides it on
//      submit, so this split is a presentation of a safety property rather
//      than the safety property itself.
//   3. THE CONFIRMATION COUNTS OUT LOUD. How many applications, to which
//      companies, from which address, and how many of those actually leave the
//      building versus being prepared as links. "Are you sure?" tells a person
//      nothing they can check.
//
// The run itself is driven exactly the way components/jobs/refresh-button.tsx
// drives the resumable refresh route: bounded rounds, a cursor that must
// strictly advance, visible progress, and a stop that leaves finished work
// finished.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ExternalLink,
  Inbox,
  Loader2,
  Mail,
  Send,
  SlashIcon,
  Sparkles,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/use-toast'
import { matchTone } from '@/lib/format'
import { cn } from '@/lib/utils'

// --- Wire shapes (mirrors of app/api/drafts/batch-approve/route.ts) ---------

export interface BatchReviewItem {
  draftId: string
  jobId: string
  jobTitle: string
  jobUrl: string | null
  location: string | null
  companyName: string
  matchScore: number | null
  matchWhy: string | null
  matchHighlights: string[]
  matchGaps: string[]
  tailoredSummary: string | null
  hasCoverLetter: boolean
  knockouts: string[]
  batchable: boolean
  mode: 'submit' | 'handoff'
  provider: 'greenhouse' | 'lever' | 'ashby' | null
  blockers: string[]
  createdAt: string
}

export interface BatchManifest {
  cap: number
  applyEmail: string
  applyEmailSource: 'settings' | 'account'
  applyEmailConfigured: string | null
  applyEmailInvalid: boolean
  accountEmail: string
  items: BatchReviewItem[]
  needsAttention: BatchReviewItem[]
  counts: {
    total: number
    batchable: number
    needsAttention: number
    willSubmit: number
    willHandoff: number
  }
}

export interface BatchItemResult {
  draftId: string
  companyName: string | null
  jobTitle: string | null
  outcome: 'submitted' | 'handoff' | 'failed' | 'blocked' | 'skipped'
  reason: string | null
  handoffUrl?: string | null
}

interface BatchRoundResponse {
  ok: boolean
  results: BatchItemResult[]
  cursor: number | null
  total: number
  done: boolean
}

/**
 * A round always advances because the server returns the next index, but a
 * server that stopped advancing would spin this forever. Two independent
 * guards, same as refresh-button.tsx: the cursor must strictly increase, and
 * the whole run is capped well above any real batch (each round covers up to
 * BATCH_ROUND_SIZE applications, and the batch itself is capped at 50).
 */
const MAX_ROUNDS = 60

// --- Pure helpers (exported so the safety rules can be tested directly) -----

export interface BatchSummary {
  count: number
  /**
   * How many could be POSTed to an employer — the irreversible part, stated as
   * a CEILING. The submission engine applies a tighter gate than this surface
   * can evaluate without going to the network per posting (see
   * BatchDecision.mode in app/api/drafts/batch-approve/eligibility.ts), so some
   * of these will arrive as prefilled links instead. Consent has to cover the
   * most that can happen, which is why the confirmation says "up to".
   */
  submitCount: number
  /** How many are already known to become a prefilled link the user opens. */
  handoffCount: number
  /** Unique company names, in list order. */
  companies: string[]
}

/**
 * The ONLY ids this surface will ever offer. Filters on `batchable` even
 * though the server already sorted the lists: select-all must be incapable of
 * reaching an item that needs individual attention, whatever list it arrives
 * in and whoever calls this next.
 */
export function selectableIds(items: readonly BatchReviewItem[]): string[] {
  return items.filter((item) => item.batchable).map((item) => item.draftId)
}

/** What the confirmation step is allowed to claim, counted from the same
 *  items the request will carry. */
export function summarizeSelection(
  items: readonly BatchReviewItem[],
  selected: ReadonlySet<string>
): BatchSummary {
  const chosen = items.filter((item) => item.batchable && selected.has(item.draftId))
  return {
    count: chosen.length,
    submitCount: chosen.filter((item) => item.mode === 'submit').length,
    handoffCount: chosen.filter((item) => item.mode !== 'submit').length,
    companies: [...new Set(chosen.map((item) => item.companyName))],
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}

/** The consequence, named and counted — never "Are you sure?". */
export function confirmationHeadline(summary: BatchSummary): string {
  const roles = `${summary.count} ${plural(summary.count, 'role')}`
  const companies = `${summary.companies.length} ${plural(summary.companies.length, 'company', 'companies')}`
  return `Apply to ${roles} at ${companies}`
}

/** The same sentence the confirm button carries, so the button and the title
 *  can never describe different actions. */
export function confirmActionLabel(summary: BatchSummary): string {
  return `Apply to ${summary.count} ${plural(summary.count, 'role')}`
}

function newBatchId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// --- Row rendering ----------------------------------------------------------

const CHECKBOX_CLASS =
  'mt-1 h-4 w-4 shrink-0 cursor-pointer rounded-[4px] border border-input bg-card ' +
  'accent-[hsl(var(--accent))] focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

function ModeLine({ item }: { item: BatchReviewItem }) {
  if (item.mode === 'submit') {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption font-medium text-foreground">
        <Send className="h-3.5 w-3.5" />
        May submit directly{item.provider ? ` via ${item.provider}` : ''}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-muted-foreground">
      <ExternalLink className="h-3.5 w-3.5" />
      Prefilled link — you finish it
    </span>
  )
}

/**
 * The approvable list. Presentational and fully controlled: it holds no
 * selection state of its own, so "nothing is selected until the user acts" is
 * a property of the caller's initial state and cannot be re-introduced here.
 */
export function BatchReviewList({
  items,
  selected,
  onToggle,
}: {
  items: readonly BatchReviewItem[]
  selected: ReadonlySet<string>
  onToggle: (draftId: string) => void
}) {
  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const checkboxId = `batch-item-${item.draftId}`
        const detailId = `batch-detail-${item.draftId}`
        const isSelected = selected.has(item.draftId)
        return (
          <li key={item.draftId}>
            <Card
              className={cn(
                'flex gap-3 p-3 transition-colors',
                isSelected ? 'border-accent bg-accent-soft/30' : 'hover:bg-muted/40'
              )}
            >
              <input
                type="checkbox"
                id={checkboxId}
                className={CHECKBOX_CLASS}
                checked={isSelected}
                onChange={() => onToggle(item.draftId)}
                aria-describedby={detailId}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <label
                    htmlFor={checkboxId}
                    className="cursor-pointer text-body font-semibold text-foreground"
                  >
                    {item.jobTitle}
                  </label>
                  <span className="text-caption text-muted-foreground">{item.companyName}</span>
                  {item.location && (
                    <span className="text-caption text-muted-foreground">· {item.location}</span>
                  )}
                  {item.matchScore !== null && (
                    <Badge tone={matchTone(item.matchScore)}>{item.matchScore} match</Badge>
                  )}
                </div>

                <div id={detailId} className="mt-1.5 space-y-1">
                  {item.matchWhy && (
                    <p className="text-caption text-muted-foreground">{item.matchWhy}</p>
                  )}
                  {item.matchHighlights.length > 0 && (
                    <p className="text-caption text-muted-foreground">
                      <span className="text-label uppercase">Strengths</span>{' '}
                      {item.matchHighlights.join(' · ')}
                    </p>
                  )}
                  {item.matchGaps.length > 0 && (
                    <p className="text-caption text-muted-foreground">
                      <span className="text-label uppercase">Gaps</span> {item.matchGaps.join(' · ')}
                    </p>
                  )}
                  {item.tailoredSummary && (
                    <p className="text-caption text-muted-foreground">
                      <span className="inline-flex items-center gap-1 text-label uppercase">
                        <Sparkles className="h-3 w-3" /> Résumé tailored toward
                      </span>{' '}
                      {item.tailoredSummary}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
                    <ModeLine item={item} />
                    <span className="text-caption text-muted-foreground">
                      {item.hasCoverLetter ? 'Cover letter written' : 'No cover letter'}
                    </span>
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
                </div>
              </div>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The items a batch may not touch. Deliberately has NO checkbox and no
 * select-all reach — an unanswered work-authorisation or salary question is
 * exactly where a wrong answer costs the user the role or misstates their
 * status to an employer, so it gets a person, one at a time.
 */
export function NeedsAttentionList({ items }: { items: readonly BatchReviewItem[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.draftId}>
          <Card className="border-dashed p-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
              <span className="text-body font-semibold text-foreground">{item.jobTitle}</span>
              <span className="text-caption text-muted-foreground">{item.companyName}</span>
              {item.matchScore !== null && (
                <Badge tone={matchTone(item.matchScore)}>{item.matchScore} match</Badge>
              )}
            </div>
            <ul className="mt-1.5 space-y-0.5">
              {item.blockers.map((blocker) => (
                <li key={blocker} className="text-caption text-muted-foreground">
                  {blocker}
                </li>
              ))}
            </ul>
            {item.jobUrl && (
              <a
                href={item.jobUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-block text-caption text-accent-deep underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                View role
              </a>
            )}
          </Card>
        </li>
      ))}
    </ul>
  )
}

/**
 * The confirmation body. Every number in it is derived from the same selection
 * the request will carry, and the two outcomes are separated because they are
 * not the same promise: a direct submit cannot be undone, a prefilled link can
 * simply be closed.
 */
export function ConfirmationBody({
  summary,
  applyEmail,
  applyEmailSource,
  accountEmail,
}: {
  summary: BatchSummary
  applyEmail: string
  applyEmailSource: 'settings' | 'account'
  accountEmail: string
}) {
  const shown = summary.companies.slice(0, 8)
  const rest = summary.companies.length - shown.length
  return (
    <div className="space-y-3 text-caption text-foreground">
      <ul className="space-y-1.5">
        {summary.submitCount > 0 && (
          <li className="flex gap-2">
            <Send className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>
              Up to{' '}
              <strong className="font-semibold">
                {summary.submitCount} {plural(summary.submitCount, 'application')}
              </strong>{' '}
              will be submitted to the employer now. That cannot be undone. Any of them whose form
              turns out to ask something only you can answer becomes a link instead.
            </span>
          </li>
        )}
        {summary.handoffCount > 0 && (
          <li className="flex gap-2">
            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>
              <strong className="font-semibold">
                {summary.handoffCount} {plural(summary.handoffCount, 'application')}
              </strong>{' '}
              will be prepared as prefilled links for you to open and finish. Nothing is sent for
              those.
            </span>
          </li>
        )}
        <li className="flex gap-2">
          <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span>
            All of them go out as <strong className="font-semibold">{applyEmail}</strong>
            {applyEmailSource === 'account' ? (
              <> — the address on your account.</>
            ) : (
              <> — your apply address, not your login ({accountEmail}).</>
            )}
          </span>
        </li>
      </ul>

      <div>
        <p className="text-label uppercase text-muted-foreground">
          {summary.companies.length} {plural(summary.companies.length, 'company', 'companies')}
        </p>
        <p className="mt-1 text-caption text-muted-foreground">
          {shown.join(', ')}
          {rest > 0 ? ` and ${rest} more` : ''}
        </p>
      </div>
    </div>
  )
}

const OUTCOME_ICON: Record<BatchItemResult['outcome'], typeof Check> = {
  submitted: CheckCircle2,
  handoff: ExternalLink,
  failed: AlertTriangle,
  blocked: AlertTriangle,
  skipped: SlashIcon,
}

/** Per-item results, so a partial failure is legible rather than a single
 *  "12 of 14 succeeded" the user cannot act on. */
export function BatchResults({ results }: { results: readonly BatchItemResult[] }) {
  return (
    <ul className="space-y-1">
      {results.map((result) => {
        const Icon = OUTCOME_ICON[result.outcome]
        return (
          <li key={result.draftId} className="flex gap-2 text-caption">
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="font-medium text-foreground">
                {result.jobTitle ?? 'Application'}
                {result.companyName ? ` · ${result.companyName}` : ''}
              </span>{' '}
              <span className="text-muted-foreground">{result.reason ?? result.outcome}</span>{' '}
              {result.handoffUrl && (
                <a
                  href={result.handoffUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-deep underline-offset-4 hover:underline"
                >
                  Open
                </a>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

// --- The surface ------------------------------------------------------------

interface Progress {
  done: number
  total: number
}

export function BatchApprove({ onChanged }: { onChanged?: () => void }) {
  const [manifest, setManifest] = useState<BatchManifest | null>(null)
  const [loading, setLoading] = useState(true)
  // Empty on purpose, and re-emptied on every load(). See this file's header.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [confirming, setConfirming] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [results, setResults] = useState<BatchItemResult[] | null>(null)
  const stopRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/drafts/batch-approve')
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error ?? `Could not load the review (${response.status})`)
      }
      setManifest(data as BatchManifest)
      setSelected(new Set<string>())
    } catch (error) {
      toast({
        title: 'Could not load the review',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const items = useMemo(() => manifest?.items ?? [], [manifest])
  const summary = useMemo(() => summarizeSelection(items, selected), [items, selected])

  const toggle = useCallback((draftId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(draftId)) next.delete(draftId)
      else next.add(draftId)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelected(new Set(selectableIds(items)))
  }, [items])

  const selectNone = useCallback(() => setSelected(new Set<string>()), [])

  const runBatch = useCallback(async () => {
    const ids = items.filter((item) => item.batchable && selected.has(item.draftId)).map((i) => i.draftId)
    if (ids.length === 0) return

    setConfirming(false)
    stopRef.current = false
    setResults(null)
    setProgress({ done: 0, total: ids.length })

    // One id for the whole run, so every round — including one the browser
    // retried after a timeout — is recognisably the same batch server-side.
    const batchId = newBatchId()
    // The moment the human clicked through the confirmation, carried on every
    // round. The submission engine refuses an authorization older than 24h
    // (lib/ats-apply/capability.ts), so this is what stops a captured payload
    // from being replayed into fresh applications next week.
    const confirmedAt = new Date().toISOString()
    const collected: BatchItemResult[] = []
    let cursor: number | null = 0
    let rounds = 0

    try {
      while (cursor !== null && !stopRef.current) {
        if (++rounds > MAX_ROUNDS) {
          throw new Error(`The batch did not finish after ${MAX_ROUNDS} rounds — stopped.`)
        }

        // Annotated because `cursor` is reassigned from this response's body;
        // without it TS chases response → data → cursor → response (TS7022).
        const response: Response = await fetch('/api/drafts/batch-approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftIds: ids, batchId, confirmed: true, confirmedAt, cursor }),
        })
        const data: BatchRoundResponse | null = await response.json().catch(() => null)
        if (!response.ok || !data?.ok) {
          const message =
            (data as { error?: string } | null)?.error ?? `Batch failed (${response.status})`
          throw new Error(message)
        }

        collected.push(...data.results)
        setResults([...collected])
        setProgress({ done: collected.length, total: data.total })
        onChanged?.()

        const previous = cursor
        cursor = data.cursor
        if (cursor !== null && cursor <= previous) {
          throw new Error('The batch stopped making progress — please try again.')
        }
      }

      const submitted = collected.filter((r) => r.outcome === 'submitted').length
      const handoff = collected.filter((r) => r.outcome === 'handoff').length
      const problems = collected.filter(
        (r) => r.outcome === 'failed' || r.outcome === 'blocked'
      ).length
      const stopped = stopRef.current
      toast({
        title: stopped ? 'Batch stopped' : 'Batch finished',
        description:
          `${submitted} submitted · ${handoff} ready to finish · ${problems} need you` +
          (stopped ? ` — stopped after ${collected.length} of ${ids.length}` : ''),
        variant: problems > 0 ? 'destructive' : undefined,
      })
    } catch (error) {
      toast({
        title: 'Batch failed',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setProgress(null)
      stopRef.current = false
      await load()
      onChanged?.()
    }
  }, [items, selected, onChanged, load])

  if (loading && !manifest) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (!manifest) return null

  if (manifest.counts.total === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="Nothing waiting for review"
        body="When autopilot prepares tailored applications overnight, they collect here so you can approve them in one pass instead of fifty."
      />
    )
  }

  const running = progress !== null

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-heading text-foreground">Morning review</h2>
            <p className="mt-1 text-caption text-muted-foreground">
              {manifest.counts.batchable} prepared{' '}
              {plural(manifest.counts.batchable, 'application')} can go out together
              {manifest.counts.needsAttention > 0
                ? `, ${manifest.counts.needsAttention} ${plural(manifest.counts.needsAttention, 'needs', 'need')} you individually`
                : ''}
              . Nothing is selected until you choose.
            </p>
            <p className="mt-1 inline-flex items-center gap-1.5 text-caption text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              Applications go out as{' '}
              <span className="font-medium text-foreground">{manifest.applyEmail}</span>
              {manifest.applyEmailSource === 'account' && ' (your account address)'}
            </p>
            {manifest.applyEmailInvalid && (
              <p className="mt-1 inline-flex items-center gap-1.5 text-caption font-medium text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                The apply address in your settings ({manifest.applyEmailConfigured}) is not a valid
                email address — fix it before applying.
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={selectAll}
              disabled={running || manifest.counts.batchable === 0}
            >
              Select all {manifest.counts.batchable}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={selectNone}
              disabled={running || summary.count === 0}
            >
              Select none
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
          {running ? (
            <>
              <Button disabled>
                <Loader2 className="h-4 w-4 animate-spin" />
                Applying {progress.done}/{progress.total}…
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  stopRef.current = true
                }}
                aria-label="Stop the batch after the current application"
                title="Stop after the current application"
              >
                <X className="h-4 w-4" />
                Stop
              </Button>
              <span className="text-caption text-muted-foreground">
                Finished applications stay finished — stopping only prevents the rest.
              </span>
            </>
          ) : (
            <>
              <Button
                onClick={() => setConfirming(true)}
                disabled={summary.count === 0 || manifest.applyEmailInvalid}
              >
                <Send className="h-4 w-4" />
                Review {summary.count} selected
              </Button>
              <span className="text-caption text-muted-foreground" aria-live="polite">
                {summary.count === 0
                  ? 'Select the applications you want to send.'
                  : `up to ${summary.submitCount} submit directly · ${summary.handoffCount} prepared as links`}
              </span>
            </>
          )}
        </div>
      </Card>

      {results && results.length > 0 && (
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-body font-semibold text-foreground">
              Results — {results.length} {plural(results.length, 'application')}
            </h3>
            {!running && (
              <Button variant="ghost" size="sm" onClick={() => setResults(null)}>
                Dismiss
              </Button>
            )}
          </div>
          <BatchResults results={results} />
        </Card>
      )}

      {items.length > 0 && (
        <section aria-labelledby="batch-ready-heading">
          <h3 id="batch-ready-heading" className="mb-2 text-label uppercase text-muted-foreground">
            Ready to approve — {items.length}
          </h3>
          <BatchReviewList items={items} selected={selected} onToggle={toggle} />
        </section>
      )}

      {manifest.needsAttention.length > 0 && (
        <section aria-labelledby="batch-attention-heading">
          <h3
            id="batch-attention-heading"
            className="mb-1 text-label uppercase text-muted-foreground"
          >
            Needs you individually — {manifest.needsAttention.length}
          </h3>
          <p className="mb-2 text-caption text-muted-foreground">
            These cannot go out in a batch. Each one asks something only you can answer — work
            authorisation, salary, clearance, demographics — or is missing something Cello will not
            invent on your behalf.
          </p>
          <NeedsAttentionList items={manifest.needsAttention} />
        </section>
      )}

      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{confirmationHeadline(summary)}</DialogTitle>
            <DialogDescription>
              Read this before it happens — some of it cannot be taken back.
            </DialogDescription>
          </DialogHeader>
          <ConfirmationBody
            summary={summary}
            applyEmail={manifest.applyEmail}
            applyEmailSource={manifest.applyEmailSource}
            accountEmail={manifest.accountEmail}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={runBatch}>
              <Check className="h-4 w-4" />
              {confirmActionLabel(summary)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
