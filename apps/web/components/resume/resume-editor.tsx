'use client'

import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export interface ResumeEditorProps {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  placeholder?: string
  className?: string
  'aria-label'?: string
}

/**
 * Plain-text resume editor. This is the ATS-facing document — it always
 * stays plain text (no rich formatting) so what the user edits here is
 * exactly what gets attached to an application.
 */
export function ResumeEditor({
  value,
  onChange,
  readOnly = false,
  placeholder,
  className,
  'aria-label': ariaLabel = 'Resume content',
}: ResumeEditorProps) {
  const charCount = value.length

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <Textarea
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        readOnly={readOnly}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        className={cn(
          'min-h-0 flex-1 resize-none font-sans text-caption leading-relaxed',
          readOnly && 'cursor-default bg-sunken/40 text-muted-foreground'
        )}
      />
      <div className="mt-1.5 text-right text-[11px] text-muted-foreground">
        {charCount.toLocaleString()} characters
      </div>
    </div>
  )
}
