'use client'

import { useCallback, useState } from 'react'
import { BarChart3, ExternalLink } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AccessibleFigure } from '@/components/charts/accessible-figure'
import { ScoreHistogramChart, type ScoreHistogramDatum } from '@/components/charts/score-histogram-chart'
import { SCORE_BAND_COLOR } from '@/components/charts/tokens'
import { SCORE_BANDS, type ScoreBand } from '@/lib/jobs/score-bands'
import { matchTone } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { InsightsSummary } from './use-insights-summary'

// The two shapes lib/harness/agents/matcher.ts (full LLM pass) and bulk_matcher.ts
// (tier-1 cheap pass) actually persist into jobs.match_details — see the psql
// verification in the PR description. Tier-1 rows genuinely don't have
// skillsMatch/experienceMatch/locationMatch/strengths/gaps; the UI below must
// say so rather than render zeros, which would be fabricated evidence.
interface JobMatchDetails {
  score?: number
  overallScore?: number
  summary?: string
  seniorityFit?: string
  skillsMatch?: number
  experienceMatch?: number
  locationMatch?: number
  strengths?: string[]
  highlights?: string[]
  gaps?: string[]
  skills?: { matched?: string[]; missing?: string[] }
  source?: string
}

interface DrilldownJob {
  id: string
  title: string
  url: string | null
  matchScore: number | null
  matchDetails: JobMatchDetails | null
  postedAt: string | null
  company: { name: string | null; domain: string | null } | null
}

const BAND_ORDER: ScoreBand[] = ['unscored', 'weak', 'fair', 'good', 'strong']

/** A tiny inline meter for one 0-100 sub-score — same track/fill language as
 *  components/charts/linear-meter.tsx but sized for a table cell. */
function SubScoreRow({ label, value }: { label: string; value: number | undefined }) {
  if (value == null) {
    return (
      <div className="flex items-center justify-between gap-3 text-caption">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">not broken down</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-caption text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right text-caption tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function EvidencePanel({ job }: { job: DrilldownJob }) {
  const d = job.matchDetails
  const hasSubScores = d && (d.skillsMatch != null || d.experienceMatch != null || d.locationMatch != null)
  const strengths = d?.strengths?.length ? d.strengths : d?.highlights ?? []
  const gaps = d?.gaps ?? []

  return (
    <div className="space-y-3 border-t border-border/60 bg-sunken/40 px-4 py-3">
      {hasSubScores ? (
        <div className="space-y-1.5">
          <SubScoreRow label="Skills match" value={d?.skillsMatch} />
          <SubScoreRow label="Experience match" value={d?.experienceMatch} />
          <SubScoreRow label="Location match" value={d?.locationMatch} />
        </div>
      ) : (
        <p className="text-caption text-muted-foreground">
          This job was scored by the bulk pre-screen, which only records an overall score — no
          skills/experience/location breakdown was computed for it.
        </p>
      )}

      {d?.summary && <p className="text-caption text-foreground">{d.summary}</p>}

      {(strengths.length > 0 || gaps.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {strengths.length > 0 && (
            <div>
              <div className="mb-1 text-caption font-medium text-emerald-700 dark:text-emerald-400">Strengths</div>
              <ul className="space-y-0.5">
                {strengths.slice(0, 3).map((s, i) => (
                  <li key={i} className="flex gap-1.5 text-caption text-muted-foreground">
                    <span className="text-emerald-700 dark:text-emerald-400" aria-hidden>
                      &#10003;
                    </span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {gaps.length > 0 && (
            <div>
              <div className="mb-1 text-caption font-medium text-amber-700 dark:text-amber-400">Gaps</div>
              <ul className="space-y-0.5">
                {gaps.slice(0, 3).map((g, i) => (
                  <li key={i} className="flex gap-1.5 text-caption text-muted-foreground">
                    <span className="text-amber-700 dark:text-amber-400" aria-hidden>
                      &bull;
                    </span>
                    <span>{g}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export interface ScoreHistogramCardProps {
  summary: InsightsSummary | null
  loading: boolean
  error: boolean
  onRetry: () => void
}

export function ScoreHistogramCard({ summary, loading, error, onRetry }: ScoreHistogramCardProps) {
  const [expandedBand, setExpandedBand] = useState<ScoreBand | null>(null)
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  const [drilldowns, setDrilldowns] = useState<Partial<Record<ScoreBand, DrilldownJob[]>>>({})
  const [drilldownLoading, setDrilldownLoading] = useState(false)

  const loadBand = useCallback(
    async (band: ScoreBand) => {
      if (drilldowns[band]) return
      setDrilldownLoading(true)
      try {
        const res = await fetch(`/api/jobs/insights-summary?band=${band}&limit=25`)
        const data = res.ok ? await res.json() : null
        setDrilldowns((prev) => ({ ...prev, [band]: data?.jobs ?? [] }))
      } catch {
        setDrilldowns((prev) => ({ ...prev, [band]: [] }))
      } finally {
        setDrilldownLoading(false)
      }
    },
    [drilldowns]
  )

  function handleBarClick(key: string) {
    const band = key as ScoreBand
    setExpandedJobId(null)
    if (expandedBand === band) {
      setExpandedBand(null)
      return
    }
    setExpandedBand(band)
    loadBand(band)
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-56 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Match score distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={BarChart3}
            title="Couldn't load match scores"
            body="This walks the full jobs table server-side and can time out under load — it doesn't mean there's no data. Try again."
            action={
              <Button variant="outline" onClick={onRetry}>
                Retry
              </Button>
            }
          />
        </CardContent>
      </Card>
    )
  }

  if (!summary || summary.totalJobs === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Match score distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={BarChart3}
            title="No jobs tracked yet"
            body="Once Cello discovers and scores jobs against your resume, their score distribution shows up here."
          />
        </CardContent>
      </Card>
    )
  }

  const data: ScoreHistogramDatum[] = BAND_ORDER.map((key) => {
    const meta = SCORE_BANDS.find((b) => b.key === key)!
    return {
      key,
      label: meta.label,
      count: summary.scoreHistogram[key] ?? 0,
      color: SCORE_BAND_COLOR[key],
    }
  })
  const scoredTotal = summary.totalJobs - summary.scoreHistogram.unscored

  const activeJobs = expandedBand ? drilldowns[expandedBand] : undefined
  const activeMeta = expandedBand ? SCORE_BANDS.find((b) => b.key === expandedBand) : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle>Match score distribution</CardTitle>
        <CardDescription>
          {summary.totalJobs.toLocaleString()} tracked jobs &middot; {scoredTotal.toLocaleString()} scored so far.
          Click a bar to see the actual jobs and why they scored that way.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AccessibleFigure
          caption={`${scoredTotal.toLocaleString()} scored jobs, mostly in the weak band — a match-quality problem, not a scoring-volume one.`}
          table={{
            columns: [
              { key: 'band', label: 'Band' },
              { key: 'count', label: 'Jobs', align: 'right' },
              { key: 'share', label: 'Share', align: 'right' },
            ],
            rows: data.map((d) => [
              d.label,
              d.count.toLocaleString(),
              summary.totalJobs === 0 ? '0%' : `${Math.round((d.count / summary.totalJobs) * 100)}%`,
            ]),
          }}
        >
          <ScoreHistogramChart data={data} activeKey={expandedBand} onBarClick={handleBarClick} />
        </AccessibleFigure>

        {/* The chart's bars are pointer-only (recharts renders plain SVG
            <path> elements, not focusable controls) — these real buttons are
            the keyboard-operable path to the same drill-down, doing exactly
            what clicking a bar does. Kept outside the role="img" figure above
            so they're never hidden from assistive tech. */}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter jobs by match-score band">
          {data.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => handleBarClick(d.key)}
              aria-pressed={expandedBand === d.key}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                expandedBand === d.key ? 'border-ring bg-sunken text-foreground' : 'border-border text-muted-foreground hover:bg-sunken/60'
              )}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
              {d.label} ({d.count.toLocaleString()})
            </button>
          ))}
        </div>

        {expandedBand && (
          <div className="overflow-hidden rounded-control border">
            <div className="flex items-center justify-between border-b bg-sunken/60 px-4 py-2">
              <span className="text-caption font-medium text-foreground">
                {activeMeta?.label} &middot; {summary.scoreHistogram[expandedBand].toLocaleString()} job
                {summary.scoreHistogram[expandedBand] === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                onClick={() => setExpandedBand(null)}
                className="rounded-control text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
            </div>

            {drilldownLoading && !activeJobs ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : activeJobs && activeJobs.length === 0 ? (
              <p className="p-4 text-caption text-muted-foreground">No jobs found in this band.</p>
            ) : (
              <ul>
                {(activeJobs ?? []).map((job) => {
                  const isOpen = expandedJobId === job.id
                  const tone = matchTone(job.matchScore)
                  return (
                    <li key={job.id} className="border-b last:border-0">
                      {/* The "open posting" link is a SIBLING of the expand
                          button, never a child. Nesting an <a> inside a
                          <button> is invalid HTML and axe flags it as
                          `nested-interactive`: assistive tech cannot reach the
                          inner control at all, so the link was unreachable by
                          keyboard and screen reader on every row. Same
                          arrangement job-row.tsx and application-card.tsx
                          already use. */}
                      <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-sunken/40">
                        <button
                          type="button"
                          onClick={() => setExpandedJobId(isOpen ? null : job.id)}
                          aria-expanded={isOpen}
                          className="flex min-w-0 flex-1 items-center gap-3 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-caption font-medium text-foreground">{job.title}</div>
                            <div className="truncate text-caption text-muted-foreground">
                              {job.company?.name ?? 'Unknown company'}
                            </div>
                          </div>
                          {job.matchScore != null && (
                            <Badge tone={tone} className="shrink-0 tabular-nums">
                              {job.matchScore}%
                            </Badge>
                          )}
                        </button>
                        {job.url && (
                          <a
                            href={job.url}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open posting for ${job.title} in a new tab`}
                            className="shrink-0 rounded-control p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                      <div
                        className={cn('grid transition-all', isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}
                      >
                        <div className="overflow-hidden">
                          <EvidencePanel job={job} />
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
