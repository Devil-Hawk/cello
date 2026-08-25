'use client'

import { Radar } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { AccessibleFigure } from '@/components/charts/accessible-figure'
import { SourcePerformanceChart, type SourcePerformanceDatum } from '@/components/charts/source-performance-chart'
import type { InsightsSummary } from './use-insights-summary'

/** Sources beyond this rank fold into "Other" — see the dataviz skill's
 *  series-count ladder ("past ~7, fold the tail rather than seat more rows"). */
const MAX_ROWS = 7

const SOURCE_LABEL: Record<string, string> = {
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
  arbeitnow: 'Arbeitnow',
  remoteok: 'RemoteOK',
  hackernews: 'Hacker News',
  ycombinator: 'Y Combinator',
  echojobs: 'EchoJobs',
  themuse: 'The Muse',
  weworkremotely: 'We Work Remotely',
  himalayas: 'Himalayas',
  workingnomads: 'Working Nomads',
  jobicy: 'Jobicy',
  remotive: 'Remotive',
  scraper: 'HTML scrape',
  web_search: 'Web search',
  '(untagged)': 'Untagged',
}

function buildRows(bySource: Record<string, { total: number; scored: number }>): SourcePerformanceDatum[] {
  const entries = Object.entries(bySource).sort((a, b) => b[1].total - a[1].total)
  const head = entries.slice(0, MAX_ROWS)
  const tail = entries.slice(MAX_ROWS)
  const rows: SourcePerformanceDatum[] = head.map(([source, counts]) => ({
    source: SOURCE_LABEL[source] ?? source,
    total: counts.total,
    scored: counts.scored,
  }))
  if (tail.length > 0) {
    const other = tail.reduce(
      (acc, [, c]) => ({ total: acc.total + c.total, scored: acc.scored + c.scored }),
      { total: 0, scored: 0 }
    )
    rows.push({ source: `Other (${tail.length})`, total: other.total, scored: other.scored })
  }
  return rows
}

export interface SourcePerformanceCardProps {
  summary: InsightsSummary | null
  loading: boolean
  error: boolean
  onRetry: () => void
}

export function SourcePerformanceCard({ summary, loading, error, onRetry }: SourcePerformanceCardProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72 max-w-full" />
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
          <CardTitle>Source performance</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Radar}
            title="Couldn't load source performance"
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
          <CardTitle>Source performance</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState icon={Radar} title="No jobs tracked yet" body="Where jobs come from shows up here once discovery runs." />
        </CardContent>
      </Card>
    )
  }

  const rows = buildRows(summary.bySource)
  const zeroScored = rows.filter((r) => r.total >= 20 && r.scored === 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Source performance</CardTitle>
        <CardDescription>
          Jobs discovered per source, and how many of them Cello has actually scored.
          {zeroScored.length > 0 && (
            <>
              {' '}
              {zeroScored.map((r) => r.source).join(', ')} contribut
              {zeroScored.length === 1 ? 'es' : 'e'} volume but {zeroScored.length === 1 ? "hasn't" : "haven't"} been
              scored at all.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AccessibleFigure
          caption="Total jobs discovered per source, with the scored subset overlaid."
          table={{
            columns: [
              { key: 'source', label: 'Source' },
              { key: 'total', label: 'Total jobs', align: 'right' },
              { key: 'scored', label: 'Scored', align: 'right' },
            ],
            rows: rows.map((r) => [r.source, r.total.toLocaleString(), r.scored.toLocaleString()]),
          }}
        >
          <SourcePerformanceChart data={rows} />
        </AccessibleFigure>
      </CardContent>
    </Card>
  )
}
