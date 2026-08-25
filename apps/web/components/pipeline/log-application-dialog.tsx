'use client'

// "I already applied" — the fast manual receipt path. Per the product
// owner's spec this is exactly four required facts (date, resume used,
// where you applied, current status) plus two optional ones (confirmation
// text, screenshot) — seconds, not CRM data entry. Every field here maps
// 1:1 to that list; resist adding more.
//
// Works without Gmail by construction: nothing in this component or the
// route it calls (POST /api/applications/receipts) ever touches Gmail.

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Paperclip, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/components/ui/use-toast'
import { STAGE_META, type PipelineStage } from '@/lib/format'
import {
  DESTINATION_PRESETS,
  MAX_ATTACHMENT_BYTES,
  RECEIPT_STAGES,
  UNKNOWN_RESUME_DOCUMENT,
  resolveDestination,
} from '@/lib/applications/receipts'
import type { ReceiptDocument } from '@/lib/applications/types'
import type { ApplicationWithJob } from '@/components/pipeline/utils'

interface ResumeOption {
  value: string
  label: string
  resumeDocumentId: string | null
}

interface ResumeDocumentLike {
  id: string
  title: string | null
  version: number
  job_id: string | null
}

function todayInputValue(): string {
  return new Date().toISOString().slice(0, 10)
}

function resumeOptionLabel(doc: ResumeDocumentLike): string {
  const kind = doc.job_id ? 'Tailored' : 'Base'
  return doc.title ? `${doc.title} (${kind} v${doc.version})` : `${kind} resume v${doc.version}`
}

export interface LogApplicationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  application: ApplicationWithJob
  /** Called after a receipt is successfully logged, with the server's honest
   *  status message — for a caller that keeps its own receipts list (e.g. the
   *  detail dialog) and wants to refresh it. The success toast is already
   *  shown by this component either way, so this is optional. */
  onLogged?: (statusMessage: string) => void
}

export function LogApplicationDialog({ open, onOpenChange, application, onLogged }: LogApplicationDialogProps) {
  const job = application.jobs
  const currentStage = application.stage as PipelineStage
  const defaultStage: PipelineStage = RECEIPT_STAGES.includes(currentStage) ? currentStage : 'applied'

  const [submittedAt, setSubmittedAt] = useState(todayInputValue())
  const [stage, setStage] = useState<PipelineStage>(defaultStage)
  const [destinationPreset, setDestinationPreset] = useState(DESTINATION_PRESETS[0].value)
  const [destinationCustom, setDestinationCustom] = useState('')
  const [resumeChoice, setResumeChoice] = useState<string>('unknown')
  const [resumeOptions, setResumeOptions] = useState<ResumeOption[]>([])
  const [confirmationIdentifier, setConfirmationIdentifier] = useState('')
  const [confirmationNote, setConfirmationNote] = useState('')
  const [attachment, setAttachment] = useState<{ name: string; dataUrl: string } | null>(null)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [monitoringMessage, setMonitoringMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function reset() {
    setSubmittedAt(todayInputValue())
    setStage(defaultStage)
    setDestinationPreset(DESTINATION_PRESETS[0].value)
    setDestinationCustom('')
    setResumeChoice('unknown')
    setConfirmationIdentifier('')
    setConfirmationNote('')
    setAttachment(null)
    setAttachmentError(null)
  }

  // Load resume options + the honest monitoring line whenever the dialog opens.
  useEffect(() => {
    if (!open || !job?.id) return
    let cancelled = false

    fetch(`/api/resume/documents?jobId=${encodeURIComponent(job.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { versions?: ResumeDocumentLike[]; base?: ResumeDocumentLike | null } | null) => {
        if (cancelled || !data) return
        const options: ResumeOption[] = []
        for (const v of data.versions ?? []) {
          options.push({ value: v.id, label: resumeOptionLabel(v), resumeDocumentId: v.id })
        }
        if (data.base && !options.some((o) => o.resumeDocumentId === data.base!.id)) {
          options.push({ value: data.base.id, label: resumeOptionLabel(data.base), resumeDocumentId: data.base.id })
        }
        setResumeOptions(options)
        if (options.length > 0) setResumeChoice(options[0].value)
      })
      .catch(() => {
        /* resume options are a convenience; the "not sure" fallback keeps the form usable */
      })

    fetch(`/api/applications/receipts?applicationId=${encodeURIComponent(application.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { monitoring?: { message?: string } } | null) => {
        if (!cancelled && data?.monitoring?.message) setMonitoringMessage(data.monitoring.message)
      })
      .catch(() => {
        /* the form still works without this preview line */
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job?.id, application.id])

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function handleFile(file: File | null) {
    setAttachmentError(null)
    if (!file) {
      setAttachment(null)
      return
    }
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) {
      setAttachmentError('Screenshot must be a PNG, JPEG, GIF, or WEBP image.')
      return
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachmentError(`Screenshot is too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB).`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAttachment({ name: file.name, dataUrl: reader.result })
      }
    }
    reader.onerror = () => setAttachmentError('Could not read that file.')
    reader.readAsDataURL(file)
  }

  const documents: ReceiptDocument[] = useMemo(() => {
    const option = resumeOptions.find((o) => o.value === resumeChoice)
    if (!option) return [UNKNOWN_RESUME_DOCUMENT]
    return [{ kind: 'resume', label: option.label, resumeDocumentId: option.resumeDocumentId }]
  }, [resumeChoice, resumeOptions])

  const destination = resolveDestination(destinationPreset, destinationCustom)
  const canSubmit =
    submittedAt.trim().length > 0 &&
    destination.trim().length > 0 &&
    !attachmentError &&
    !busy

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    try {
      const res = await fetch('/api/applications/receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: application.id,
          submittedAt: new Date(submittedAt).toISOString(),
          destination,
          documents,
          confirmationIdentifier: confirmationIdentifier.trim() || null,
          confirmationNote: confirmationNote.trim() || null,
          confirmationAttachmentUrl: attachment?.dataUrl ?? null,
          stage,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(Array.isArray(data.errors) ? data.errors.join(' ') : data.error ?? 'Could not log this application')
      }
      toast({ title: 'Application logged', description: data.statusMessage })
      onLogged?.(data.statusMessage as string)
      handleOpenChange(false)
    } catch (e) {
      toast({
        title: 'Could not log this application',
        description: e instanceof Error ? e.message : 'Something went wrong',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>I already applied</DialogTitle>
          <DialogDescription>
            {job?.title ? `${job.title}${job.companies?.name ? ` at ${job.companies.name}` : ''}` : 'Log this application'}
            {' — a few quick details, no email required.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="receipt-date" className="mb-1.5 block text-caption font-medium text-foreground">
                Application date
              </label>
              <Input
                id="receipt-date"
                type="date"
                value={submittedAt}
                max={todayInputValue()}
                onChange={(e) => setSubmittedAt(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="receipt-stage" className="mb-1.5 block text-caption font-medium text-foreground">
                Current status
              </label>
              <Select value={stage} onValueChange={(v) => setStage(v as PipelineStage)}>
                <SelectTrigger id="receipt-stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECEIPT_STAGES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STAGE_META[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label htmlFor="receipt-destination" className="mb-1.5 block text-caption font-medium text-foreground">
              Where did you apply?
            </label>
            <Select value={destinationPreset} onValueChange={setDestinationPreset}>
              <SelectTrigger id="receipt-destination">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DESTINATION_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {destinationPreset === 'other' && (
              <Input
                className="mt-2"
                placeholder="e.g. company careers page, a friend forwarded it, etc."
                value={destinationCustom}
                onChange={(e) => setDestinationCustom(e.target.value)}
              />
            )}
          </div>

          <div>
            <label htmlFor="receipt-resume" className="mb-1.5 block text-caption font-medium text-foreground">
              Resume used
            </label>
            <Select value={resumeChoice} onValueChange={setResumeChoice}>
              <SelectTrigger id="receipt-resume">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {resumeOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
                <SelectItem value="unknown">{UNKNOWN_RESUME_DOCUMENT.label}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <details className="group">
            <summary className="cursor-pointer text-caption font-medium text-muted-foreground hover:text-foreground">
              Add confirmation (optional)
            </summary>
            <div className="mt-2 space-y-2">
              <Input
                placeholder="Confirmation number, if you got one"
                value={confirmationIdentifier}
                onChange={(e) => setConfirmationIdentifier(e.target.value)}
              />
              <Textarea
                placeholder="Paste confirmation text, e.g. from an email"
                value={confirmationNote}
                onChange={(e) => setConfirmationNote(e.target.value)}
                className="min-h-[72px] text-caption"
              />
              {attachment ? (
                <div className="flex items-center justify-between gap-2 rounded-control border bg-sunken/60 px-3 py-2">
                  <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-caption text-foreground">
                    <Paperclip className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{attachment.name}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachment(null)}
                    className="shrink-0 rounded-control p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Remove attachment"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <label className="flex cursor-pointer items-center gap-2 rounded-control border border-dashed px-3 py-2 text-caption text-muted-foreground hover:bg-sunken/60">
                  <Paperclip className="h-3.5 w-3.5" />
                  Attach a screenshot
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="hidden"
                    onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              )}
              {attachmentError && <p className="text-caption text-red-600 dark:text-red-400">{attachmentError}</p>}
            </div>
          </details>

          {monitoringMessage && (
            <p className="rounded-control bg-sunken/60 px-3 py-2 text-caption text-muted-foreground">
              {monitoringMessage}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Log application
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
