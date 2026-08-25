import { Badge } from '@/components/ui/badge'
import { matchTone } from '@/lib/format'
import type { Breakdown } from './compute'

export interface WhatsWorkingProps {
  title: string
  description?: string
  rows: Breakdown[]
}

/**
 * A "what's working" cut: response rate broken down by some dimension (match-score
 * band, source, outreach). Each row shows applied count, responded count, and a
 * tone-colored response-rate badge. Response rate reuses matchTone thresholds so
 * the color language is consistent with the rest of the app.
 */
export function WhatsWorking({ title, description, rows }: WhatsWorkingProps) {
  return (
    <div>
      <div className="mb-3">
        <h3 className="font-display text-section text-foreground">{title}</h3>
        {description && <p className="mt-0.5 text-caption text-muted-foreground">{description}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="text-caption text-muted-foreground">Not enough data yet.</p>
      ) : (
        <div className="divide-y divide-border/60">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1 truncate text-body text-foreground">{row.label}</span>
              <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
                {row.responded}/{row.applied} responded
              </span>
              <Badge tone={row.responseRate == null ? 'none' : matchTone(row.responseRate)} className="shrink-0 tabular-nums">
                {row.responseRate == null ? '—' : `${row.responseRate}%`}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
