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

// Literal class names so Tailwind sees them; the row sizes to what is shown.
const COLS: Record<number, string> = {
  1: 'sm:grid-cols-1',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-5',
}

/**
 * One card, N stats separated by hairline rules, display-font tabular numerals.
 * A stat whose value is the number 0 or the rate 0% is not drawn (a bare zero gives a person
 * nothing to act on); with none left the row is not drawn at all.
 */
export function StatRow({ stats, className, ...props }: StatRowProps) {
  const shown = stats.filter((s) => s.value !== 0 && s.value !== '0%')
  if (shown.length === 0) return null
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-card border bg-border shadow-card',
        COLS[Math.min(shown.length, 5)],
        className
      )}
      {...props}
    >
      {shown.map((stat, i) => {
        // An odd last tile spans the phone's two columns so no grey cell shows.
        const span = shown.length % 2 === 1 && i === shown.length - 1 ? ' col-span-2 sm:col-span-1' : ''
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
              className={`block bg-card px-5 py-4${span} transition-colors hover:bg-sunken/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
            >
              {content}
            </Link>
          )
        }

        return (
          <div key={stat.label} className={`bg-card px-5 py-4${span}`}>
            {content}
          </div>
        )
      })}
    </div>
  )
}
