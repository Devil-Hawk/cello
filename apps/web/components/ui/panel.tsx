import * as React from 'react'
import { cn } from '@/lib/utils'

export type PanelTone = 'sunken' | 'accent' | 'good' | 'warn' | 'bad' | 'plain'
export type PanelDivider = 'top' | 'left' | 'none'

// good/warn/bad ARE the system's status vocabulary — the same three pipeline
// instrument tones (tailwind.config.ts `pipeline.*`) used for "how did this
// go" everywhere else (kanban stages, score bars, chart tokens in
// globals.css). Fixed hex, not theme-varying HSL vars, on purpose: they're
// already tuned to read on both the light parchment and dark charcoal
// surfaces (see globals.css "Chart tokens" comment). Point new "is this
// good/bad/uncertain" UI at these three, the same way lib/format.ts's
// STAGE_META does for stage chips — raw emerald/amber/red utility classes
// are exactly the palette drift this file exists to prevent.
const TONE_CLASSES: Record<PanelTone, string> = {
  sunken: 'bg-sunken/60 border-border',
  accent: 'bg-accent-tint border-accent/30',
  good: 'bg-pipeline-offer/[0.12] border-pipeline-offer/30',
  warn: 'bg-pipeline-screen/[0.12] border-pipeline-screen/30',
  bad: 'bg-pipeline-rejected/[0.12] border-pipeline-rejected/30',
  plain: 'bg-transparent border-border',
}

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: PanelTone
  /**
   * 'top' — hairline rule above the panel (use when it follows other content
   * in the same Card, e.g. under a CardHeader).
   * 'left' — a single accent-coloured edge (use for inline notices/alerts).
   * 'none' — tint only, no rule (use for a standalone grouped block).
   */
  divider?: PanelDivider
}

/**
 * A group of content living inside an existing Card. Deliberately NOT a
 * bordered, rounded box — a Card is a surface, and surfaces must not contain
 * surfaces. Panel expresses "a distinct region" with background tint and a
 * hairline rule instead, so it reads as depth within the surface rather than
 * another card stacked inside it.
 */
const Panel = React.forwardRef<HTMLDivElement, PanelProps>(
  ({ className, tone = 'sunken', divider = 'top', children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-none px-4 py-3.5',
        TONE_CLASSES[tone],
        divider === 'top' && 'border-t',
        divider === 'left' && 'border-l-2',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
)
Panel.displayName = 'Panel'

export { Panel }
