'use client'

import Link from 'next/link'
import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Loader2, PauseCircle, Sparkles, XCircle, type LucideIcon } from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { TiltCard } from '@/components/ui/motion'
import { formatRelativeTime } from '@/lib/utils'

export type AgentRunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'completed'
  // A run where at least one step FAILED (or the run was aborted on
  // budget/deadline before finishing) but something still completed. Kept
  // distinct from plain 'completed' — see lib/graph/runs.ts's finalStatus
  // computation.
  | 'completed_with_errors'
  // harnessRunGraph hit its deadline interrupt() (or an ask-form/review
  // wait) with a real checkpoint behind it; app/api/harness/cron/route.ts's
  // resume pass re-enters it. NOT a failure. 'incomplete' (the pre-port
  // executor's own pause state) is retired — see lib/harness/types.ts's
  // RunStatus. Mirrors that file and components/copilot/runs-panel.tsx's
  // STATUS_META — keep all three in sync.
  | 'paused'
  | 'failed'
  | 'cancelled'

export interface LatestAgentRun {
  id: string
  goal: string
  status: AgentRunStatus
  createdAt: string
  finishedAt: string | null
  error: string | null
}

const STATUS_META: Record<AgentRunStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  queued: { label: 'Queued', tone: 'neutral', icon: CircleDashed },
  planning: { label: 'Planning', tone: 'neutral', icon: Loader2 },
  running: { label: 'Running', tone: 'accent', icon: Loader2 },
  completed: { label: 'Completed', tone: 'good', icon: CheckCircle2 },
  completed_with_errors: { label: 'Completed with errors', tone: 'warn', icon: AlertTriangle },
  // Paused at the time limit and will resume itself — a better outcome than
  // 'failed', so deliberately muted rather than warned.
  paused: { label: 'Paused — resuming', tone: 'muted', icon: PauseCircle },
  failed: { label: 'Failed', tone: 'bad', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'muted', icon: Clock },
}

interface AgentActivityCardProps {
  run: LatestAgentRun | null
}

/** Latest agent_runs row: what the agent last did, and whether it worked. */
export function AgentActivityCard({ run }: AgentActivityCardProps) {
  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agent activity</CardTitle>
          <CardDescription>The last automated sourcing/matching run.</CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Sparkles}
            title="No agent runs yet"
            body="Start one from the Copilot page — sourcing, matching, and interview prep all run there."
            action={
              <Button size="sm" asChild>
                <Link href="/copilot">Start a run</Link>
              </Button>
            }
          />
        </CardContent>
      </Card>
    )
  }

  const meta = STATUS_META[run.status]
  const Icon = meta.icon
  const isActive = run.status === 'running' || run.status === 'planning' || run.status === 'queued'
  const when = run.finishedAt ? formatRelativeTime(run.finishedAt) : formatRelativeTime(run.createdAt)

  return (
    // TiltCard: a restrained pointer-follow tilt + lift on a "primary" glance
    // widget — layered elevation (shadow, not a heavier border) standing in
    // for the depth the user asked 3D assets for.
    <TiltCard className="rounded-card hover:shadow-pop">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Agent activity</CardTitle>
            <CardDescription>
              Last run {isActive ? 'started' : 'finished'} {when}.
            </CardDescription>
          </div>
          <Link href="/copilot" className="text-caption font-medium text-accent-deep hover:underline">
            View runs
          </Link>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3">
            <Badge tone={meta.tone} className="shrink-0">
              <Icon className={`h-3 w-3 ${isActive ? 'animate-spin' : ''}`} aria-hidden />
              {meta.label}
            </Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate text-body text-foreground">{run.goal}</p>
              {/* One plain sentence, with the executor's own string behind a
                  disclosure. This used to print `run.error` verbatim and
                  clamped to two lines — "run failed: 0 of 3 step(s) completed
                  (1 failed, 2 skipped)" — on the page a user lands on. That is
                  internal step bookkeeping, in a red that suggested they had
                  done something wrong, with no cause and no way to act on it.
                  The raw text stays reachable because it is the only thing that
                  ties this card to a log. */}
              {(run.status === 'failed' || run.status === 'completed_with_errors') && run.error && (
                <details className="group/err mt-1">
                  <summary className="cursor-pointer list-none text-caption text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {run.status === 'failed'
                      ? "This run didn't finish. See what failed"
                      : 'This run finished with problems. See what failed'}
                  </summary>
                  <p className="mt-1.5 whitespace-pre-wrap break-words rounded-control bg-sunken/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {run.error}
                  </p>
                </details>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </TiltCard>
  )
}
