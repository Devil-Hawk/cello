import * as React from 'react'
import { cn } from '@/lib/utils'
import { toneBadgeClass, type MatchTone } from '@/lib/format'

export type BadgeTone = MatchTone | 'accent' | 'neutral'

const EXTRA_TONE_CLASSES: Record<'accent' | 'neutral', string> = {
  // Accent is reserved for "new / attention" moments, never scores or stages.
  accent: 'border-transparent bg-accent-soft text-accent-deep',
  neutral: 'border-transparent bg-sunken text-foreground',
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
}

function badgeToneClass(tone: BadgeTone): string {
  if (tone === 'accent' || tone === 'neutral') return EXTRA_TONE_CLASSES[tone]
  return toneBadgeClass(tone)
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, tone = 'neutral', ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption font-medium',
        badgeToneClass(tone),
        className
      )}
      {...props}
    />
  )
)
Badge.displayName = 'Badge'

export { Badge, badgeToneClass }
