'use client'

import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { chanceLabel, firstGapCopy } from '@/lib/scoring/read'
import type { RoleFit } from '@/lib/scoring/types'
import { cn } from '@/lib/utils'

/** Why each word is on the chip, in the person's terms. Strong has a fixed line; the others name the first gap. */
function tooltipFor(fit: RoleFit | null): string | null {
  const label = fit?.chance?.label
  if (label === 'strong') return 'Your resume shows everything it asks for.'
  if (label === 'possible' || label === 'stretch') return fit ? firstGapCopy(fit) : null
  if (!label || label === 'cannot_assess') return 'Cello has not checked this role against your resume yet.'
  return null
}

const TONE: Record<string, string> = {
  // Selection and primary meaning use the accent; the rest stay neutral so a list never reads as a scoreboard.
  strong: 'border-accent bg-transparent text-accent-deep',
  possible: 'border-border bg-transparent text-foreground',
  stretch: 'border-dashed border-border bg-transparent text-muted-foreground',
  none: 'border-transparent bg-sunken text-muted-foreground',
}

/**
 * The word for a role's chance: Strong, Possible, Stretch or Not assessed yet.
 * It never shows a number. Hover or focus for the reason.
 */
export function ChanceChip({ fit, className }: { fit: RoleFit | null; className?: string }) {
  const label = chanceLabel(fit?.chance ?? null)
  const key = label === 'Not assessed yet' ? 'none' : label.toLowerCase()
  const tip = tooltipFor(fit)
  const chip = (
    <Badge tone="neutral" className={cn('whitespace-nowrap border', TONE[key], className)}>
      {label}
    </Badge>
  )
  if (!tip) return chip
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={`Chance: ${label}. ${tip}`} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {chip}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          {tip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
