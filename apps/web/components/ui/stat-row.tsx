import * as React from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

export interface StatRowItem {
  label: string
  value: React.ReactNode
  /** Optional deep-link (e.g. /jobs?fresh=7d) — the whole stat becomes clickable. */
  href?: string
  /** Optional short qualifier rendered after the value (e.g. "this week"). */
  hint?: string
}

export interface StatRowProps extends React.HTMLAttributes<HTMLDivElement> {
  stats: StatRowItem[]
}

/** One card, N stats separated by hairline rules, display-font tabular numerals. */
export function StatRow({ stats, className, ...props }: StatRowProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-card border bg-border shadow-card sm:grid-cols-4',
        className
      )}
      {...props}
    >
      {stats.map((stat) => {
        const content = (
          <>
            <div className="font-readout text-label uppercase tracking-[0.12em] text-muted-foreground">
              {stat.label}
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="font-readout text-stat font-bold tabular-nums text-foreground">
                {stat.value}
              </span>
              {stat.hint && (
                <span className="text-caption text-muted-foreground">{stat.hint}</span>
              )}
            </div>
          </>
        )

        if (stat.href) {
          return (
            <Link
              key={stat.label}
              href={stat.href}
              className="block bg-card px-5 py-4 transition-colors hover:bg-sunken/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {content}
            </Link>
          )
        }

        return (
          <div key={stat.label} className="bg-card px-5 py-4">
            {content}
          </div>
        )
      })}
    </div>
  )
}
