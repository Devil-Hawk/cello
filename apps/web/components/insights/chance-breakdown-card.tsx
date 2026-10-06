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
import { CHANCE_BAND_COLOR } from '@/components/charts/tokens'
import { ChanceChip } from '@/components/fit/chance-chip'
import { FitPanel } from '@/components/fit/fit-panel'
import { CHANCE_BANDS, type ChanceBand } from '@/lib/jobs/chance-bands'
import { parseFit, type FitRow } from '@/lib/scoring/read'
import { cn } from '@/lib/utils'
import type { InsightsSummary } from './use-insights-summary'

// A drill-down row is a role with its verdict columns; FitPanel reads them with
// parseFit, so what shows here is exactly what the role's own detail shows: why
// the person might want it, and a cited resume line for every requirement met.
interface DrilldownJob extends FitRow {
  id: string
  title: string
  url: string | null
  postedAt: string | null
  company: { name: string | null; domain: string | null } | null
}

const BAND_ORDER: ChanceBand[] = ['unassessed', 'filtered', 'stretch', 'possible', 'strong']

export interface ChanceBreakdownCardProps {
  summary: InsightsSummary | null
  loading: boolean
  error: boolean
  onRetry: () => void
}

/** How the person's roles break down by chance, with the actual roles behind every bar. */
export function ChanceBreakdownCard({ summary, loading, error, onRetry }: ChanceBreakdownCardProps) {
  const [expandedBand, setExpandedBand] = useState<ChanceBand | null>(null)
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  const [drilldowns, setDrilldowns] = useState<Partial<Record<ChanceBand, DrilldownJob[]>>>({})
  const [drilldownLoading, setDrilldownLoading] = useState(false)

  const loadBand = useCallback(
    async (band: ChanceBand) => {
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
    const band = key as ChanceBand
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
          <CardTitle>Your chances by role</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={BarChart3}
            title="Couldn't load your chances"
            body="This reads every tracked role server-side and can time out under load. It doesn't mean there's no data. Try again."
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
          <CardTitle>Your chances by role</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={BarChart3}
            title="No roles tracked yet"
            body="Once Cello discovers roles and checks them against your resume, how they break down by chance shows up here."
          />
        </CardContent>
      </Card>
    )
  }

  const data: ScoreHistogramDatum[] = BAND_ORDER.map((key) => {
    const meta = CHANCE_BANDS.find((b) => b.key === key)!
    return { key, label: meta.label, count: summary.chanceHistogram[key] ?? 0, color: CHANCE_BAND_COLOR[key] }
  })
  const assessedTotal = summary.totalJobs - summary.chanceHistogram.unassessed

  const activeJobs = expandedBand ? drilldowns[expandedBand] : undefined
  const activeMeta = expandedBand ? CHANCE_BANDS.find((b) => b.key === expandedBand) : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your chances by role</CardTitle>
        <CardDescription>
          {summary.totalJobs.toLocaleString()} tracked roles &middot; {assessedTotal.toLocaleString()} checked so far. Click a
          bar to see the actual roles and the resume line behind each call.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AccessibleFigure
          caption={`${assessedTotal.toLocaleString()} roles checked against your resume, grouped by how strong your chance looks.`}
          table={{
            columns: [
              { key: 'band', label: 'Chance' },
              { key: 'count', label: 'Roles', align: 'right' },
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

        {/* The chart's bars are pointer-only (recharts renders plain SVG paths, not focusable
            controls), so these real buttons are the keyboard path to the same drill-down. Kept
            outside the role="img" figure above so they are never hidden from assistive tech. */}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter roles by chance">
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
                {activeMeta?.label} &middot; {summary.chanceHistogram[expandedBand].toLocaleString()} role
                {summary.chanceHistogram[expandedBand] === 1 ? '' : 's'}
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
              <p className="p-4 text-caption text-muted-foreground">No roles found here.</p>
            ) : (
              <ul>
                {(activeJobs ?? []).map((job) => {
                  const isOpen = expandedJobId === job.id
                  const fit = parseFit(job)
                  return (
                    <li key={job.id} className="border-b last:border-0">
                      {/* The "open posting" link is a SIBLING of the expand button, never a child:
                          an <a> inside a <button> is invalid HTML, and assistive tech cannot reach it. */}
                      <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-sunken/40">
                        <button
                          type="button"
                          onClick={() => setExpandedJobId(isOpen ? null : job.id)}
                          aria-expanded={isOpen}
                          className="flex min-w-0 flex-1 items-center gap-3 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-caption font-medium text-foreground">{job.title}</div>
                            <div className="truncate text-caption text-muted-foreground">{job.company?.name ?? 'Unknown company'}</div>
                          </div>
                          {fit.blocked.length > 0 ? (
                            <Badge tone="muted" className="shrink-0">
                              Filtered out
                            </Badge>
                          ) : (
                            <ChanceChip fit={fit} className="shrink-0" />
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
                      <div className={cn('grid transition-all', isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
                        <div className="overflow-hidden">
                          <div className="border-t border-border/60 bg-sunken/40 px-4 py-3">
                            <FitPanel fit={fit} />
                          </div>
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
