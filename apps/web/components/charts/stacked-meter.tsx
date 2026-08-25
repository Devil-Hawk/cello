'use client'

import { cn } from '@/lib/utils'

export interface StackedMeterSegment {
  key: string
  label: string
  count: number
  color: string
}

export interface StackedMeterProps {
  segments: StackedMeterSegment[]
  activeKey: string | null
  onSegmentClick?: (key: string) => void
}

/**
 * A single 100%-stacked horizontal bar for part-to-whole data (e.g. the
 * provenance/trust mix) — the default form for 2-4 categories, per the
 * dataviz skill's choosing-a-form guidance ("Part-to-whole -> stacked bar"; a
 * pie/donut is deliberately not used here). Each segment is a real button —
 * click one to see the jobs behind it.
 */
export function StackedMeter({ segments, activeKey, onSegmentClick }: StackedMeterProps) {
  const total = segments.reduce((sum, s) => sum + s.count, 0)

  return (
    <div className="space-y-3">
      <div className="flex h-8 w-full overflow-hidden rounded-md bg-sunken" role="presentation">
        {segments.map((seg) => {
          const pct = total === 0 ? 0 : (seg.count / total) * 100
          if (pct === 0) return null
          const isDimmed = activeKey != null && activeKey !== seg.key
          const Tag = onSegmentClick ? 'button' : 'div'
          return (
            <Tag
              key={seg.key}
              type={onSegmentClick ? 'button' : undefined}
              onClick={onSegmentClick ? () => onSegmentClick(seg.key) : undefined}
              className={cn(
                'h-full border-r-2 border-card first:rounded-l-md last:rounded-r-md last:border-r-0 transition-opacity',
                onSegmentClick && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
              )}
              style={{ width: `${pct}%`, backgroundColor: seg.color, opacity: isDimmed ? 0.45 : 1 }}
              aria-label={`${seg.label}: ${seg.count} (${Math.round(pct)}%)`}
              title={`${seg.label}: ${seg.count} (${Math.round(pct)}%)`}
            />
          )
        })}
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {segments.map((seg) => {
          const pct = total === 0 ? 0 : Math.round((seg.count / total) * 100)
          const isDimmed = activeKey != null && activeKey !== seg.key
          const content = (
            <>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: seg.color }} />
              <span className="text-caption text-foreground">{seg.label}</span>
              <span className="text-caption tabular-nums text-muted-foreground">
                {seg.count.toLocaleString()} &middot; {pct}%
              </span>
            </>
          )
          if (!onSegmentClick) {
            return (
              <div key={seg.key} className={cn('flex items-center gap-1.5', isDimmed && 'opacity-45')}>
                {content}
              </div>
            )
          }
          return (
            <button
              key={seg.key}
              type="button"
              onClick={() => onSegmentClick(seg.key)}
              className={cn(
                'flex items-center gap-1.5 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isDimmed && 'opacity-45'
              )}
            >
              {content}
            </button>
          )
        })}
      </div>
    </div>
  )
}
