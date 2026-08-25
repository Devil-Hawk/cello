'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string = string> {
  value: T
  label: React.ReactNode
}

export interface SegmentedProps<T extends string = string> {
  options: SegmentedOption<T>[]
  value: T | null
  onValueChange: (value: T) => void
  className?: string
  'aria-label'?: string
}

/**
 * Segmented control: sunken track, raised active segment.
 * Used for mutually-exclusive filters (e.g. freshness 24h/3d/7d/14d/30d).
 */
export function Segmented<T extends string = string>({
  options,
  value,
  onValueChange,
  className,
  'aria-label': ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-control border bg-sunken p-0.5',
        className
      )}
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'rounded-[6px] px-2.5 py-1 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-card text-foreground shadow-card'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
