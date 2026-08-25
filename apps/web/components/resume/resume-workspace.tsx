'use client'

// The document half of the resume studio: template picker, formatted editor,
// live preview and the existing side-by-side diff, behind one Edit/Preview/Diff
// switch. Version history, generation, saving and downloading stay with the
// page — this component owns no data and performs no requests.
//
// WHAT THE CALLER OWES THE SERVER (the contract this UI is built to feed)
//   The buffer here is MARKDOWN, and it is the authored document. The plain
//   text an ATS reads is DERIVED from it, server-side. So a save is:
//
//     POST /api/resume/documents
//     { action: 'save', jobId, markdown, templateId, source }
//
//   and NOT a `content` field written by the client. See lib/resume/types.ts:
//   if both sides can author, the two representations drift, and the drifted
//   plain text is the copy the employer's parser actually reads.
//
//   Reading back: `resolveResumeMarkdown(doc)` gives the Markdown for a version
//   and falls back to `doc.content` for every row stored before formatting
//   existed (content_json === null is legal and common — those rows are plain
//   text, which is valid Markdown and renders as paragraphs with their line
//   structure intact). `getResumeTemplateId(doc.content_json)` gives the stored
//   template; pass it through `getTemplate()` for the default.
//
// WHY DIFF STAYS ON THE MARKDOWN
//   Diffing the derived plain text would hide exactly the edits this feature
//   adds — promoting a line to a section heading, or bolding a title, would
//   show as "no change". The caller therefore passes the COMPARE version's
//   Markdown (resolveResumeMarkdown of the older version), and the diff is
//   Markdown-to-Markdown.

import { useState } from 'react'
import { Segmented } from '@/components/ui/segmented'
import { cn } from '@/lib/utils'
import { MarkdownEditor } from './markdown-editor'
import { ResumeDiff } from './resume-diff'
import { ResumePreview } from './resume-preview'
import { TemplatePicker } from './template-picker'

export type ResumeWorkspaceMode = 'edit' | 'preview' | 'diff'

export interface ResumeWorkspaceProps {
  /** The authored Markdown being edited. */
  markdown: string
  onMarkdownChange: (markdown: string) => void
  /** Selected template id — persisted as content_json.templateId on save. */
  templateId: string
  onTemplateChange: (templateId: string) => void
  /** The compared version's MARKDOWN, or null when there is nothing to diff. */
  compareMarkdown?: string | null
  compareLabel?: string
  currentLabel?: string
  /** Controlled mode. Omit both to let the workspace manage it internally. */
  mode?: ResumeWorkspaceMode
  onModeChange?: (mode: ResumeWorkspaceMode) => void
  defaultMode?: ResumeWorkspaceMode
  /**
   * Read-only shows the typeset document and nothing else — used before any
   * version exists, where the point is "here is the resume we have on file".
   */
  readOnly?: boolean
  /** Height of the pane. Defaults to the studio's 520px. */
  paneClassName?: string
  className?: string
}

export function ResumeWorkspace({
  markdown,
  onMarkdownChange,
  templateId,
  onTemplateChange,
  compareMarkdown = null,
  compareLabel = 'Previous version',
  currentLabel = 'Current draft',
  mode,
  onModeChange,
  defaultMode = 'edit',
  readOnly = false,
  paneClassName = 'h-[520px]',
  className,
}: ResumeWorkspaceProps) {
  const [internalMode, setInternalMode] = useState<ResumeWorkspaceMode>(defaultMode)
  const requested = mode ?? internalMode
  // A mode whose pane cannot exist falls back to editing rather than rendering
  // an empty box — the compare version disappears whenever the newest version
  // is selected.
  const active: ResumeWorkspaceMode =
    requested === 'diff' && compareMarkdown === null ? 'edit' : requested

  function setMode(next: ResumeWorkspaceMode) {
    if (!mode) setInternalMode(next)
    onModeChange?.(next)
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      <TemplatePicker value={templateId} onChange={onTemplateChange} />

      {!readOnly && (
        <Segmented
          aria-label="Document view"
          value={active}
          onValueChange={(value) => setMode(value as ResumeWorkspaceMode)}
          options={
            compareMarkdown === null
              ? [
                  { value: 'edit', label: 'Edit' },
                  { value: 'preview', label: 'Preview' },
                ]
              : [
                  { value: 'edit', label: 'Edit' },
                  { value: 'preview', label: 'Preview' },
                  { value: 'diff', label: 'Diff' },
                ]
          }
        />
      )}

      {readOnly || active === 'preview' ? (
        <ResumePreview
          markdown={markdown}
          templateId={templateId}
          className={paneClassName}
          aria-label="Formatted resume preview"
        />
      ) : active === 'diff' && compareMarkdown !== null ? (
        <ResumeDiff
          before={compareMarkdown}
          after={markdown}
          beforeLabel={compareLabel}
          afterLabel={currentLabel}
          className={paneClassName}
        />
      ) : (
        // Edit: source on the left, the same document typeset on the right.
        // The preview only appears once there is room for both — below that
        // width the Preview tab is how you see it, rather than two unusable
        // columns.
        <div className={cn('grid min-h-0 gap-3 xl:grid-cols-2', paneClassName)}>
          <MarkdownEditor
            value={markdown}
            onChange={onMarkdownChange}
            label="Resume editor"
            placeholder="Start typing a resume…"
            className="min-h-0"
          />
          <ResumePreview
            markdown={markdown}
            templateId={templateId}
            className="hidden min-h-0 xl:block"
            aria-label="Live preview of the formatted resume"
          />
        </div>
      )}
    </div>
  )
}
