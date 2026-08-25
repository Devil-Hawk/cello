import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon: LucideIcon
  title: string
  /** One-line supporting copy. */
  body?: string
  /** Usually a single Button or link. */
  action?: React.ReactNode
  /**
   * Heading level for `title` — defaults to h2. EmptyState is almost always
   * the entire content of a page right after its h1 (no h2 has been rendered
   * yet), so h2 is the safe default; pass "h3" when nesting inside a
   * section that already has its own h2.
   */
  headingLevel?: 'h1' | 'h2' | 'h3' | 'h4'
}

/**
 * Compact empty state for filtered / no-result moments: a solid panel with a
 * raised icon housing, headline, one-line body, and one action. Reads as an
 * intentional readout with nothing to show — never a dashed placeholder.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
  headingLevel: Heading = 'h2',
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-card border bg-card px-8 py-14 text-center',
        className
      )}
      {...props}
    >
      {/* Raised via shadow + tint, not a border — a surface must not contain
          another bordered surface, even a small one. */}
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-card bg-raised text-muted-foreground shadow-raised">
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <Heading className="font-display text-section text-foreground">{title}</Heading>
      {body && <p className="mt-1.5 max-w-sm text-caption text-muted-foreground">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
