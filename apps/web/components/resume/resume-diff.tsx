'use client'

import { useMemo } from 'react'
import { diffLines, diffStats, toSplitRows } from '@/lib/resume/diff'
import { cn } from '@/lib/utils'

export interface ResumeDiffProps {
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  className?: string
}

/**
 * Side-by-side diff of two resume texts. Additions are highlighted in the
 * right column, removals in the left column, and unchanged lines are shown
 * in both — this is the "preview of what it would edit" surface, meant to be
 * read BEFORE anything gets saved.
 */
export function ResumeDiff({ before, after, beforeLabel = 'Before', afterLabel = 'After', className }: ResumeDiffProps) {
  const rows = useMemo(() => toSplitRows(diffLines(before, after)), [before, after])
  const stats = useMemo(() => diffStats(diffLines(before, after)), [before, after])
  const identical = stats.added === 0 && stats.removed === 0

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="mb-2 flex items-center justify-between text-label uppercase text-muted-foreground">
        <span>Comparing versions</span>
        {identical ? (
          <span>No differences</span>
        ) : (
          <span className="tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{stats.added}</span>{' '}
            <span className="text-red-600 dark:text-red-400">-{stats.removed}</span>
          </span>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border overflow-hidden rounded-control border">
        <div className="min-w-0 overflow-auto">
          <div className="sticky top-0 border-b bg-sunken px-3 py-1.5 text-label uppercase text-muted-foreground">
            {beforeLabel}
          </div>
          <pre className="whitespace-pre-wrap break-words px-3 py-2 font-sans text-caption leading-relaxed">
            {rows.map((row, idx) => (
              <div
                key={idx}
                className={cn(
                  'min-h-[1.4em] px-1',
                  row.type === 'remove' && 'bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-200'
                )}
              >
                {row.left ?? ' '}
              </div>
            ))}
          </pre>
        </div>
        <div className="min-w-0 overflow-auto">
          <div className="sticky top-0 border-b bg-sunken px-3 py-1.5 text-label uppercase text-muted-foreground">
            {afterLabel}
          </div>
          <pre className="whitespace-pre-wrap break-words px-3 py-2 font-sans text-caption leading-relaxed">
            {rows.map((row, idx) => (
              <div
                key={idx}
                className={cn(
                  'min-h-[1.4em] px-1',
                  row.type === 'add' && 'bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200'
                )}
              >
                {row.right ?? ' '}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  )
}
