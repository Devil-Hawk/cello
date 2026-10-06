'use client'

// One place a resume comes in: choose a file or paste text. A text file saves at once. A photo or
// a scanned PDF is read by a model, then shown next to the picture to check before it is saved,
// because a misread name or number is something no code can catch. Nothing is written until
// "Save as my resume", and Cancel writes nothing.

import { useRef, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  RESUME_UPLOAD_ACCEPT,
  RESUME_UPLOAD_MAX_BYTES,
  RESUME_UPLOAD_MAX_LABEL,
  SUPPORTED_FORMATS_SENTENCE,
  detectResumeFormat,
  isLegacyDoc,
} from '@/lib/resume/import/formats'

export interface ResumeImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once a resume is saved, so the page can reload. */
  onSaved?: () => void
  templateId?: string
}

type Phase =
  | { name: 'choose' }
  | { name: 'working'; label: string }
  | { name: 'error'; message: string }
  | { name: 'review'; picture: string | null; saveError: string | null }
  | { name: 'saved'; version: number | null }

const post = async (url: string, body: FormData | Record<string, unknown>) => {
  const isForm = body instanceof FormData
  const res = await fetch(url, {
    method: 'POST',
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? body : JSON.stringify(body),
  })
  return { res, data: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

export function ResumeImportDialog({ open, onOpenChange, onSaved, templateId }: ResumeImportDialogProps) {
  const [phase, setPhase] = useState<Phase>({ name: 'choose' })
  const [pasted, setPasted] = useState('')
  const [draft, setDraft] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const pasteBox = useRef<HTMLTextAreaElement>(null)

  function close(next: boolean) {
    if (!next) {
      if (phase.name === 'review' && phase.picture) URL.revokeObjectURL(phase.picture)
      setPhase({ name: 'choose' })
      setPasted('')
      setDraft('')
    }
    onOpenChange(next)
  }

  async function run(input: { file?: File; text?: string }) {
    const { file, text } = input
    if (file) {
      if (isLegacyDoc(file.name, file.type)) return setPhase({ name: 'error', message: 'Old .doc files cannot be read. Save it as .docx or PDF and try again.' })
      if (!detectResumeFormat(file.name, file.type)) return setPhase({ name: 'error', message: `That file type cannot be read. Use ${SUPPORTED_FORMATS_SENTENCE}.` })
      if (file.size > RESUME_UPLOAD_MAX_BYTES) return setPhase({ name: 'error', message: `That file is over ${RESUME_UPLOAD_MAX_LABEL}.` })
    }
    setPhase({ name: 'working', label: 'Reading your resume' })
    try {
      const form = new FormData()
      if (file) form.append('resume', file)
      const first = file ? await post('/api/resume/upload', form) : await post('/api/resume/upload', { text })
      if (first.res.ok && first.data?.success) {
        setPhase({ name: 'saved', version: typeof first.data.version === 'number' ? first.data.version : null })
        return onSaved?.()
      }
      if (file && first.data?.code === 'needs_transcribe') {
        setPhase({ name: 'working', label: 'Reading the picture' })
        form.append('mode', 'transcribe')
        const read = await post('/api/resume/upload', form)
        if (read.res.ok && typeof read.data?.text === 'string') {
          setDraft(read.data.text)
          return setPhase({ name: 'review', picture: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, saveError: null })
        }
        const message =
          read.data?.code === 'needs_ocr'
            ? 'Reading a photo needs a model. Paste the text instead.'
            : read.data?.code === 'demo_blocked'
              ? String(read.data.error)
              : 'Could not read that picture. Paste the text instead.'
        return setPhase({ name: 'error', message })
      }
      setPhase({ name: 'error', message: typeof first.data?.error === 'string' ? first.data.error : 'Could not read that resume.' })
    } catch {
      setPhase({ name: 'error', message: 'Could not read that resume.' })
    }
  }

  async function saveReview() {
    if (phase.name !== 'review' || !draft.trim()) return
    const picture = phase.picture
    setPhase({ name: 'working', label: 'Saving' })
    try {
      const { res, data } = await post('/api/resume/documents', { action: 'save', jobId: null, source: 'base', markdown: draft, templateId })
      if (!res.ok || !data?.document) throw new Error()
      if (picture) URL.revokeObjectURL(picture)
      setPhase({ name: 'saved', version: (data.document as { version?: number }).version ?? null })
      onSaved?.()
    } catch {
      // The text stays on screen so nothing is lost.
      setPhase({ name: 'review', picture, saveError: 'Could not save. Your last saved version is unchanged.' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{phase.name === 'review' ? 'Check this text' : phase.name === 'saved' ? 'Resume saved' : 'Add your resume'}</DialogTitle>
          <DialogDescription>
            {phase.name === 'review'
              ? 'Fix anything misread, then save. Nothing replaces your resume until you do.'
              : phase.name === 'saved'
                ? 'It is your base resume now.'
                : `${SUPPORTED_FORMATS_SENTENCE}, up to ${RESUME_UPLOAD_MAX_LABEL}.`}
          </DialogDescription>
        </DialogHeader>

        {phase.name === 'choose' && (
          <div className="space-y-4">
            <input
              ref={fileInput}
              type="file"
              accept={RESUME_UPLOAD_ACCEPT}
              className="hidden"
              data-testid="import-file"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void run({ file: f })
              }}
            />
            <Button type="button" variant="outline" className="min-h-11 w-full" onClick={() => fileInput.current?.click()}>
              <Upload aria-hidden="true" className="h-4 w-4" />
              Choose a file or a photo
            </Button>
            <Textarea ref={pasteBox} value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} placeholder="Or paste your resume text here" aria-label="Resume text" />
            <DialogFooter>
              <Button className="min-h-11" disabled={!pasted.trim()} onClick={() => run({ text: pasted })}>
                Use this text
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase.name === 'working' && (
          <p role="status" className="flex items-center gap-2 text-body">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            {phase.label}
          </p>
        )}

        {phase.name === 'error' && (
          <div role="alert" className="space-y-3">
            <p className="text-body text-destructive">{phase.message}</p>
            <DialogFooter>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  setPhase({ name: 'choose' })
                  setTimeout(() => pasteBox.current?.focus(), 0)
                }}
              >
                Paste the text instead
              </Button>
              <Button className="min-h-11" onClick={() => setPhase({ name: 'choose' })}>
                Choose another file
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase.name === 'review' && (
          <div className="space-y-3">
            <div className={phase.picture ? 'grid gap-3 md:grid-cols-2' : ''}>
              {phase.picture && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={phase.picture} alt="Your picture" className="max-h-[50vh] w-full rounded-card border bg-white object-contain" />
              )}
              <Textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setPhase({ ...phase, saveError: null })
                }}
                rows={14}
                spellCheck={false}
                aria-label="The text read from your picture"
              />
            </div>
            {phase.saveError && (
              <p role="alert" className="text-caption text-destructive">
                {phase.saveError}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" className="min-h-11" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button className="min-h-11" disabled={!draft.trim()} onClick={saveReview}>
                Save as my resume
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase.name === 'saved' && (
          <div className="space-y-3">
            <p className="text-body font-medium">{phase.version ? `Saved as version ${phase.version}.` : 'Saved.'}</p>
            <DialogFooter>
              <Button className="min-h-11" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
