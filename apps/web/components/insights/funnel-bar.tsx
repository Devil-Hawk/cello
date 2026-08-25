import Link from 'next/link'
import { STAGE_META, type PipelineStage } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AccessibleFigure } from '@/components/charts/accessible-figure'

const ORDER: PipelineStage[] = [
  'discovered',
  'applied',
  'screen',
  'interview',
  'offer',
  'ghosted',
  'rejected',
]

export interface FunnelBarProps {
  funnel: Record<PipelineStage, number>
}

/**
 * Horizontal funnel: one row per pipeline stage, bar width proportional to the
 * largest stage count, colored with the shared STAGE_META palette (never
 * orange). Each stage is a real link into /pipeline?stage=X — "how many
 * applications are in Interview" becomes "click to go see which ones",
 * instead of a number that dead-ends.
 */
export function FunnelBar({ funnel }: FunnelBarProps) {
  const max = Math.max(1, ...ORDER.map((s) => funnel[s] ?? 0))
  const total = ORDER.reduce((sum, s) => sum + (funnel[s] ?? 0), 0)
  return (
    <AccessibleFigure
      interactive
      caption={`${total.toLocaleString()} tracked applications across the pipeline. Click a stage to open it on the board.`}
      table={{
        columns: [
          { key: 'stage', label: 'Stage' },
          { key: 'count', label: 'Applications', align: 'right' },
        ],
        rows: ORDER.map((s) => [STAGE_META[s].label, (funnel[s] ?? 0).toLocaleString()]),
      }}
    >
      <ol className="space-y-2.5">
        {ORDER.map((stage) => {
        const meta = STAGE_META[stage]
        const count = funnel[stage] ?? 0
        const pct = Math.round((count / max) * 100)
        return (
          <li key={stage}>
            <Link
              href={`/pipeline?stage=${stage}`}
              className="group flex items-center gap-3 rounded-control py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${meta.label}: ${count} application${count === 1 ? '' : 's'} — open on the pipeline board`}
            >
              <span className="flex w-24 shrink-0 items-center gap-2">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', meta.dotClass)} aria-hidden />
                <span className="text-caption text-muted-foreground group-hover:text-foreground">
                  {meta.label}
                </span>
              </span>
              <span className="relative h-6 flex-1 overflow-hidden rounded-md bg-sunken">
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 block h-full rounded-md transition-all group-hover:brightness-110',
                    meta.barClass
                  )}
                  style={{ width: `${count === 0 ? 0 : Math.max(4, pct)}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right font-display text-body tabular-nums text-foreground">
                {count}
              </span>
            </Link>
          </li>
        )
      })}
    </ol>
    </AccessibleFigure>
  )
}
