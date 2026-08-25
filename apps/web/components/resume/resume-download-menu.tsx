'use client'

// Download the selected version, in the format the recipient actually wants.
//
// WHY TWO FORMATS AND NOT ONE
//   A PDF is what you send: it is the document, laid out, and it cannot be
//   reflowed by whatever opens it. A .docx is what some employers and older
//   applicant-tracking systems demand instead — several will only accept an
//   editable file, and a recruiter often wants to add a cover sheet or strip a
//   contact detail before passing it on. Offering only one of the two means the
//   user re-types their resume somewhere else, which is the failure this whole
//   feature exists to end. The menu says which is which rather than making the
//   user guess from a file extension.
//
// THE TEMPLATE TRAVELS WITH THE REQUEST
//   `templateId` is sent as a query parameter so a download reflects the
//   template currently chosen in the picker even when it has not been saved
//   yet. The server falls back to the version's stored content_json.templateId
//   and then to the registry default, so an omitted or unknown id still renders.
//
// DOCX MAY NOT EXIST YET
//   The .docx renderer is server-side work that lands separately; until it does
//   the route answers 501. That is reported honestly ("not available yet") and
//   the item stays visible, because hiding it would make a shipped feature look
//   like a missing one the moment it lands.

import { useState } from 'react'
import { ChevronDown, Download, FileText, FileType, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'

export type ResumeDownloadFormat = 'pdf' | 'docx'

const EXTENSION: Record<ResumeDownloadFormat, string> = { pdf: 'pdf', docx: 'docx' }

export interface ResumeDownloadMenuProps {
  /** The saved version to export. Null disables the menu (nothing is saved yet). */
  documentId: string | null
  /** The template the picker currently shows. */
  templateId: string
  /** Base name for the saved file, e.g. "resume-v3". */
  filenameBase?: string
  /** True when the editor holds edits the saved version does not have. */
  hasUnsavedChanges?: boolean
  disabled?: boolean
  className?: string
}

/** Prefer the filename the server chose; fall back to ours. */
function filenameFrom(header: string | null, fallback: string): string {
  const match = header ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header) : null
  return match?.[1] ? decodeURIComponent(match[1]) : fallback
}

export function ResumeDownloadMenu({
  documentId,
  templateId,
  filenameBase = 'resume',
  hasUnsavedChanges = false,
  disabled,
  className,
}: ResumeDownloadMenuProps) {
  const { toast } = useToast()
  const [busy, setBusy] = useState<ResumeDownloadFormat | null>(null)

  async function download(format: ResumeDownloadFormat) {
    if (!documentId || busy) return
    setBusy(format)
    try {
      const params = new URLSearchParams({ id: documentId, format, templateId })
      const res = await fetch(`/api/resume/documents?${params.toString()}`)

      if (!res.ok) {
        let message = `Download failed (HTTP ${res.status}).`
        try {
          const data = (await res.json()) as { error?: string }
          if (data?.error) message = data.error
        } catch {
          /* body wasn't JSON — keep the generic message */
        }
        // The .docx renderer lands server-side separately. Until it does the
        // route answers 501 (not implemented) or rejects the format outright,
        // and either way the useful thing to say is "not yet, use the PDF" —
        // not the route's own wording about which formats it accepts.
        if (
          format === 'docx' &&
          (res.status === 501 || (res.status === 400 && /format/i.test(message)))
        ) {
          message =
            "Word (.docx) export isn't available yet — the document renderer for it hasn't shipped. The PDF is ready now."
        }
        throw new Error(message)
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filenameFrom(
        res.headers.get('Content-Disposition'),
        `${filenameBase}.${EXTENSION[format]}`
      )
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('[resume-studio] download failed', { format }, err)
      toast({
        title: format === 'pdf' ? 'PDF download failed' : 'Word download failed',
        description: err instanceof Error ? err.message : 'Try again.',
        variant: 'destructive',
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled || !documentId} className={className}>
          {busy ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          Download
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {hasUnsavedChanges && (
          <>
            <DropdownMenuLabel className="font-normal text-[11px] leading-snug text-muted-foreground">
              Exports the last saved version — save to include your current edits.
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          onSelect={() => {
            void download('pdf')
          }}
          className="items-start gap-2"
        >
          <FileText aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0">
            <span className="block font-medium text-foreground">PDF</span>
            <span className="block text-[11px] leading-snug text-muted-foreground">
              Send this to employers — the layout is fixed.
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void download('docx')
          }}
          className="items-start gap-2"
        >
          <FileType aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0">
            <span className="block font-medium text-foreground">Word (.docx)</span>
            <span className="block text-[11px] leading-snug text-muted-foreground">
              When an employer or ATS asks for an editable file.
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
