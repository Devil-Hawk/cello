'use client'

// Wires GET /api/strategy onto the Insights surface (docs/PRODUCT-VISION.md
// #6 / "STRATEGY"). lib/strategy/* is STRUCTURALLY unable to report a rate
// below its documented minimum sample size (see lib/strategy/types.ts's
// QuestionResult) — at the account's current real volume, every outcome
// question below is expected to render as "not enough data yet", and that is
// the correct, honest thing to show, not a loading bug or an empty chart.

import { useCallback, useEffect, useState } from 'react'
import { Check, Clock, Compass, Loader2, Minus, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { QuestionResult, StrategyProposal, StrategyReport } from '@/lib/strategy/types'
// Type-only: lib/strategy/measure.ts's runtime imports reach toward
// lib/strategy/datasource.ts's service-role admin client chain (same concern
// components/settings/targeting-tab.tsx documents for JobScopeCounts). An
// `import type` is fully erased by the compiler, so this client component
// never bundles that chain — only the shape of `ProposalEffectData` survives.
import type { ProposalEffectData } from '@/lib/strategy/measure'

interface QuestionRowSpec {
  id: string
  label: string
  result: QuestionResult<unknown>
}

function QuestionRow({ spec }: { spec: QuestionRowSpec }) {
  const { label, result } = spec
  return (
    <div className="py-3">
      <p className="text-body font-medium text-foreground">{label}</p>
      {result.status === 'insufficient_data' ? (
        <p className="mt-1 text-caption text-muted-foreground">{result.message}</p>
      ) : (
        <div className="mt-1 space-y-1">
          <p className="text-caption text-foreground">{result.summary}</p>
          {result.caveats.length > 0 && (
            <ul className="space-y-0.5 text-caption text-muted-foreground">
              {result.caveats.map((c, i) => (
                <li key={i}>· {c}</li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground">Based on {result.sampleSize} applications.</p>
        </div>
      )}
    </div>
  )
}

/**
 * One recorded acceptance, as returned by GET/POST /api/strategy/outcomes.
 * `result` is exactly lib/strategy/measure.ts#measureProposalEffect's return
 * — insufficient_data while still inside the observation window/new-jobs
 * floor, answered once a verdict exists.
 */
interface AcceptedOutcome {
  id: string
  proposalId: string
  question: string
  title: string
  acceptedAt: string
  result: QuestionResult<ProposalEffectData>
}

/**
 * The measured-effect line under an accepted proposal. Still inside the
 * observation window: render measure.ts's own refusal message plainly, as
 * information rather than an error or a blank — never a premature rate. Once
 * answered: the verdict in the pipeline ramp (good/bad/muted), NEVER accent —
 * a settled measurement is not a live signal (globals.css's DESIGN
 * AUTHORITY). A regression is shown exactly as plainly as an improvement;
 * the point of closing this loop is learning what did not work.
 */
function ProposalOutcomeStatus({ outcome }: { outcome: AcceptedOutcome }) {
  const { result } = outcome

  if (result.status === 'insufficient_data') {
    return (
      <div className="mt-2 flex items-start gap-1.5 text-caption text-muted-foreground">
        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>Measuring — {result.message}</p>
      </div>
    )
  }

  const verdict = result.data.verdict
  const toneClass =
    verdict === 'improved' ? 'text-pipeline-offer' : verdict === 'regressed' ? 'text-pipeline-rejected' : 'text-muted-foreground'
  const Icon = verdict === 'improved' ? TrendingUp : verdict === 'regressed' ? TrendingDown : Minus

  return (
    <div className="mt-2 space-y-1">
      <div className={cn('flex items-start gap-1.5 text-caption', toneClass)}>
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p className="text-foreground">{result.summary}</p>
      </div>
      {result.caveats.length > 0 && (
        <ul className="space-y-0.5 text-caption text-muted-foreground">
          {result.caveats.map((c, i) => (
            <li key={i}>· {c}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function StrategyPanel() {
  const [report, setReport] = useState<StrategyReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Keyed by StrategyProposal.title, not .id — proposals.ts's id carries a
  // per-process counter (see that file's `counter`) that is NOT stable across
  // a report reload, while title is the deterministic wording a acceptance
  // was recorded under (see measure.ts's AcceptedProposalRecord.title doc).
  // GET /api/strategy/outcomes returns newest-first, so keeping only the
  // first entry seen per title keeps the most recent acceptance of that
  // recommendation.
  const [outcomesByTitle, setOutcomesByTitle] = useState<Map<string, AcceptedOutcome>>(new Map())
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [acceptError, setAcceptError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/strategy')
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.report) throw new Error(data?.error ?? `Failed to load strategy (HTTP ${res.status})`)
      setReport(data.report as StrategyReport)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load strategy')
    } finally {
      setLoading(false)
    }
  }, [])

  // Supplementary, not blocking — a failed load here just means proposals
  // render without their acceptance state instead of breaking the report.
  const loadOutcomes = useCallback(async () => {
    try {
      const res = await fetch('/api/strategy/outcomes')
      const data = await res.json().catch(() => null)
      if (!res.ok || !Array.isArray(data?.outcomes)) return
      const byTitle = new Map<string, AcceptedOutcome>()
      for (const o of data.outcomes as AcceptedOutcome[]) {
        if (!byTitle.has(o.title)) byTitle.set(o.title, o)
      }
      setOutcomesByTitle(byTitle)
    } catch (e) {
      console.error('[strategy-panel] failed to load outcomes', e)
    }
  }, [])

  useEffect(() => {
    load()
    loadOutcomes()
  }, [load, loadOutcomes])

  const acceptProposal = useCallback(async (p: StrategyProposal) => {
    setAcceptingId(p.id)
    setAcceptError(null)
    try {
      const res = await fetch('/api/strategy/outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // question mirrors StrategyProposal.evidence[].question — see
        // measure.ts's AcceptedProposalRecord.question doc.
        body: JSON.stringify({ proposalId: p.id, question: p.evidence[0]?.question ?? p.id.split('-')[0], title: p.title }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.outcome) throw new Error(data?.error ?? `Failed to record acceptance (HTTP ${res.status})`)
      setOutcomesByTitle((prev) => new Map(prev).set(p.title, data.outcome as AcceptedOutcome))
    } catch (e) {
      setAcceptError(e instanceof Error ? e.message : 'Failed to record acceptance')
    } finally {
      setAcceptingId(null)
    }
  }, [])

  const rows: QuestionRowSpec[] = report
    ? [
        { id: 'sourceFunnel', label: 'Which sources produce interviews', result: report.sourceFunnel },
        { id: 'matchScoreAccuracy', label: 'Does match score predict responses', result: report.matchScoreAccuracy },
        { id: 'resumeVariants', label: 'Which resume variant performs best', result: report.resumeVariants },
        { id: 'outreachImpact', label: 'Does outreach improve response rate', result: report.outreachImpact },
        {
          id: 'rejectionPatterns',
          label: 'Which companies or roles consistently reject you',
          result: report.rejectionPatterns,
        },
        { id: 'applicationTiming', label: 'Are applications sent too late', result: report.applicationTiming },
        {
          id: 'recurringEvidence',
          label: 'What evidence recurs in your successful applications',
          result: report.recurringEvidence,
        },
      ]
    : []

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Compass className="h-4 w-4 text-muted-foreground" />
            Strategy
          </CardTitle>
          <p className="mt-1 text-caption text-muted-foreground">
            What Cello can honestly say about your search so far — no chart until there&apos;s enough data to trust it.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            load()
            loadOutcomes()
          }}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="flex items-center justify-between gap-3 rounded-control border border-red-400/40 bg-red-50/60 px-3 py-2 text-caption text-foreground dark:bg-red-500/5">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={load}>
              Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : report ? (
          <>
            <div className="divide-y">
              {rows.map((spec) => (
                <QuestionRow key={spec.id} spec={spec} />
              ))}

              {/* filterImpact isn't gated the same way (it's a job-VOLUME
                  question, answerable regardless of outcome data) — only its
                  nested causal claim (does loosening targeting help OUTCOMES)
                  stays a gated QuestionResult. See lib/strategy/types.ts. */}
              <div className="py-3">
                <p className="text-body font-medium text-foreground">Is your targeting too strict</p>
                <p className="mt-1 text-caption text-muted-foreground">
                  {report.filterImpact.totalPassingAllConfiguredFilters} of {report.filterImpact.totalJobsInScope}{' '}
                  tracked jobs pass your current filters — {report.filterImpact.totalExcluded} excluded,{' '}
                  {report.filterImpact.jobsWithNoDescription} have no description at all.
                </p>
                <p className="mt-1 text-caption text-muted-foreground">
                  {report.filterImpact.causalEvidence.status === 'insufficient_data'
                    ? report.filterImpact.causalEvidence.message
                    : report.filterImpact.causalEvidence.summary}
                </p>
              </div>
            </div>

            {report.proposals.length > 0 && (
              <div className="mt-4 space-y-3">
                <p className="text-label uppercase text-muted-foreground">Proposed changes</p>
                {acceptError && <p className="text-caption text-pipeline-rejected">{acceptError}</p>}
                {report.proposals.map((p) => {
                  const outcome = outcomesByTitle.get(p.title)
                  return (
                    // Accent means "waiting on the user" (globals.css's DESIGN
                    // AUTHORITY) — true of a proposal awaiting a decision, no
                    // longer true once it's been accepted, so tone reverts to
                    // sunken the moment an outcome exists.
                    <Panel key={p.id} tone={outcome ? 'sunken' : 'accent'} divider="none" className="rounded-control">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-body font-medium text-foreground">{p.title}</p>
                        <Badge tone={outcome ? 'neutral' : 'accent'} className="shrink-0">
                          {outcome ? 'Accepted' : 'AI proposed'}
                        </Badge>
                      </div>
                      <p className="mt-1 text-caption text-foreground">{p.change}</p>
                      <p className="mt-1 text-caption text-muted-foreground">{p.why}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{p.expectedEffect}</p>
                      {outcome ? (
                        <ProposalOutcomeStatus outcome={outcome} />
                      ) : (
                        <div className="mt-2">
                          <Button size="sm" variant="outline" onClick={() => acceptProposal(p)} disabled={acceptingId === p.id}>
                            {acceptingId === p.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                            Accept
                          </Button>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Records today&apos;s job-scope numbers as a baseline, then reports back once enough time and
                            new jobs have passed to measure the effect.
                          </p>
                        </div>
                      )}
                    </Panel>
                  )
                })}
              </div>
            )}

            {report.totalApplications === 0 && (
              <p className="mt-4 text-caption text-muted-foreground">
                Cello needs applications on file before it can say anything about outcomes — apply to a few roles and
                check back.
              </p>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
