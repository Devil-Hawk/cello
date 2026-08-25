'use client'

import Link from 'next/link'
import { KanbanSquare, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { StatRow, type StatRowItem } from '@/components/ui/stat-row'
import { CountUp } from '@/components/ui/motion'
import { STAGE_META, type PipelineStage } from '@/lib/format'

// The stages worth a glance from the dashboard — terminal states (ghosted,
// rejected) are omitted here; the full board on /pipeline shows all 7.
const SNAPSHOT_STAGES: readonly PipelineStage[] = [
  'discovered',
  'applied',
  'screen',
  'interview',
  'offer',
]

export interface FollowUpSummary {
  overdueCount: number
  upcomingCount: number
}

interface PipelineSnapshotProps {
  applicationsCount: number
  stageCounts: Partial<Record<PipelineStage, number>>
  followUps: FollowUpSummary
}

/**
 * Compact pipeline readout for the dashboard: stage counts + follow-up
 * pressure, or an honest empty state when there is nothing tracked yet.
 */
export function PipelineSnapshot({ applicationsCount, stageCounts, followUps }: PipelineSnapshotProps) {
  if (applicationsCount === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h2">Pipeline</CardTitle>
          <CardDescription>Where your applications live once you start applying.</CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={KanbanSquare}
            title="No applications yet"
            body="Apply to a job from Jobs — it'll show up here once you do."
            action={
              <Button size="sm" asChild>
                <Link href="/jobs">
                  <Plus className="h-4 w-4" />
                  Browse jobs
                </Link>
              </Button>
            }
          />
        </CardContent>
      </Card>
    )
  }

  const stageStats: StatRowItem[] = SNAPSHOT_STAGES.map((stage) => ({
    label: STAGE_META[stage].label,
    value: <CountUp value={stageCounts[stage] ?? 0} />,
    href: '/pipeline',
  }))

  const hasFollowUps = followUps.overdueCount > 0 || followUps.upcomingCount > 0

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle as="h2">Pipeline</CardTitle>
          <CardDescription>
            {applicationsCount} application{applicationsCount === 1 ? '' : 's'} tracked.
          </CardDescription>
        </div>
        <Link href="/pipeline" className="text-caption font-medium text-accent-deep hover:underline">
          View board
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
        <StatRow stats={stageStats} className="sm:grid-cols-5" />
        {hasFollowUps ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-caption">
            {followUps.overdueCount > 0 && (
              <Link
                href="/pipeline"
                className="font-medium text-pipeline-rejected hover:underline"
              >
                {followUps.overdueCount} overdue follow-up{followUps.overdueCount === 1 ? '' : 's'}
              </Link>
            )}
            {followUps.upcomingCount > 0 && (
              <Link href="/pipeline" className="text-muted-foreground hover:underline">
                {followUps.upcomingCount} upcoming follow-up{followUps.upcomingCount === 1 ? '' : 's'}
              </Link>
            )}
          </div>
        ) : (
          <p className="text-caption text-muted-foreground">No follow-ups scheduled.</p>
        )}
      </CardContent>
    </Card>
  )
}
