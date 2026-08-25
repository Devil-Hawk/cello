import type { TooltipContentProps } from 'recharts'
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent'

/**
 * Recharts' default tooltip renders a plain white box that ignores the theme.
 * This is the design-system-matching replacement — same card surface, border,
 * and shadow as everything else — passed as `content={ChartTooltip}` to
 * a recharts <Tooltip>.
 */
export function ChartTooltip({ active, payload, label }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload || payload.length === 0) return null

  return (
    <div className="rounded-control border bg-popover px-3 py-2 text-caption shadow-pop">
      {label != null && <div className="mb-1 font-medium text-foreground">{label}</div>}
      <div className="space-y-0.5">
        {payload.map((entry, i) => (
          <div key={i} className="flex items-center gap-2 text-muted-foreground">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: (entry.color as string) ?? undefined }}
            />
            <span>{entry.name}</span>
            <span className="ml-auto font-medium tabular-nums text-foreground">{entry.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
