import { cn } from '@/lib/utils'
import { STAGE_META, type PipelineStage } from '@/lib/format'

const PREVIEW_STAGES: readonly PipelineStage[] = [
  'discovered',
  'applied',
  'screen',
  'interview',
  'offer',
]

/**
 * A quiet outline of the board shown behind the pipeline empty state.
 *
 * Deliberately shows NO counts and NO card silhouettes: an earlier version
 * sketched fake cards with hardcoded numbers (3 / 2 / 2 / 1 / 1), which read as
 * real data and made an empty board look like a broken one. The columns alone
 * communicate the shape; the empty-state copy on top explains what to do.
 */
export function PipelineEmptyPreview() {
  return (
    <div className="grid grid-cols-5 gap-3" aria-hidden="true">
      {PREVIEW_STAGES.map((stage) => {
        const meta = STAGE_META[stage]
        return (
          <div
            key={stage}
            className="flex min-w-0 flex-col overflow-hidden rounded-card border border-dashed bg-card/40"
          >
            <div className={cn('h-[3px] opacity-40', meta.barClass)} />
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span className={cn('h-2 w-2 rounded-full opacity-50', meta.dotClass)} />
              <span className="truncate text-caption text-muted-foreground">{meta.label}</span>
            </div>
            <div className="h-24" />
          </div>
        )
      })}
    </div>
  )
}
