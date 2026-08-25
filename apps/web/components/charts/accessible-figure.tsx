import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface TableColumn {
  key: string
  label: string
  align?: 'left' | 'right'
}

export interface AccessibleFigureProps {
  /** Plain-language summary of what the chart shows — rendered visibly under
   *  it (not sr-only): captions help every reader, not just screen readers. */
  caption: string
  /** The visual chart. */
  children: ReactNode
  /** The same data as a real <table> — every chart's mandatory text
   *  alternative. Collapsed by default so it never competes with the chart
   *  for attention, but always present, never a chart with no fallback. */
  table: { columns: TableColumn[]; rows: (string | number)[][] }
  className?: string
  /**
   * Set when `children` contains real focusable controls (e.g. each bar is
   * also a link/button, like the pipeline funnel's "click a stage to filter
   * into it"). `role="img"` asserts an atomic, non-interactive graphic —
   * putting focusable descendants inside one is an axe-core
   * "nested-interactive" violation, and screen readers generally won't let
   * users reach into an img-role container's children at all. Interactive
   * charts skip the role="img" wrapper and lean on the visible caption
   * below (still rendered either way) for the equivalent text description.
   */
  interactive?: boolean
}

/**
 * Wraps a chart in a <figure>, gives it a visible caption, and ships a
 * collapsible <table> with the identical data — the text alternative every
 * chart in this product needs (a bar chart alone is invisible to a screen
 * reader; a caption or a data table fallback must exist somewhere, per the
 * accessibility rule this whole surface was built under).
 */
export function AccessibleFigure({ caption, children, table, className, interactive = false }: AccessibleFigureProps) {
  return (
    <figure className={cn('space-y-2', className)}>
      {interactive ? (
        <div>{children}</div>
      ) : (
        <div role="img" aria-label={caption}>
          {children}
        </div>
      )}
      <figcaption className="text-caption text-muted-foreground">{caption}</figcaption>
      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-caption font-medium text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          View as table
        </summary>
        <div className="mt-2 overflow-x-auto rounded-control border">
          <table className="w-full text-caption">
            <thead>
              <tr className="border-b bg-sunken/60">
                {table.columns.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    className={cn(
                      'px-3 py-2 font-medium text-muted-foreground',
                      col.align === 'right' ? 'text-right' : 'text-left'
                    )}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i} className="border-b last:border-0">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={cn(
                        'px-3 py-1.5 tabular-nums text-foreground',
                        table.columns[j]?.align === 'right' ? 'text-right' : 'text-left'
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}
