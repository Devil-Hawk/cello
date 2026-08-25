'use client'

import { FileText } from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { matchTone } from '@/lib/format'
import { formatRelativeTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { ResumeDocument, ResumeSource } from '@/lib/resume/types'

const SOURCE_LABEL: Record<ResumeSource, string> = {
  base: 'Base',
  tailored: 'Tailored',
  edited: 'Edited',
}

const SOURCE_TONE: Record<ResumeSource, BadgeTone> = {
  base: 'neutral',
  tailored: 'accent',
  edited: 'muted',
}

export interface VersionListProps {
  versions: ResumeDocument[]
  selectedId: string | null
  onSelect: (id: string) => void
  className?: string
}

/** Left rail: every saved version of a resume bucket, newest first. */
export function VersionList({ versions, selectedId, onSelect, className }: VersionListProps) {
  if (versions.length === 0) {
    return (
      <div className={cn('py-6 text-center text-caption text-muted-foreground', className)}>
        <FileText className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
        No saved versions yet.
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-1', className)} role="listbox" aria-label="Resume versions">
      {versions.map((v) => {
        const isSelected = v.id === selectedId
        const source: ResumeSource = v.source ?? 'base'
        const tone = matchTone(v.ats_score)
        return (
          <button
            key={v.id}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => onSelect(v.id)}
            className={cn(
              'flex flex-col gap-1 rounded-control px-3 py-2 text-left transition-colors',
              isSelected ? 'bg-sunken text-foreground' : 'hover:bg-sunken/60'
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption font-medium text-foreground">v{v.version}</span>
              <Badge tone={SOURCE_TONE[source]}>{SOURCE_LABEL[source]}</Badge>
            </div>
            {v.title && <div className="truncate text-caption text-muted-foreground">{v.title}</div>}
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>{formatRelativeTime(v.created_at)}</span>
              {v.ats_score !== null && (
                <span className={cn('font-medium tabular-nums', tone === 'good' && 'text-emerald-600 dark:text-emerald-400', tone === 'warn' && 'text-amber-600 dark:text-amber-400', tone === 'bad' && 'text-red-600 dark:text-red-400')}>
                  ATS {v.ats_score}
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
