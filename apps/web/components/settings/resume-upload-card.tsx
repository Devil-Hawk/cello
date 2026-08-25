'use client'

import { useRef, useState } from 'react'
import { FileText, Loader2, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  RESUME_UPLOAD_ACCEPT,
  RESUME_UPLOAD_MAX_BYTES,
  RESUME_UPLOAD_MAX_LABEL,
  SUPPORTED_FORMATS_SENTENCE,
  detectResumeFormat,
  isLegacyDoc,
} from '@/lib/resume/import/formats'

export type ResumeStatus = 'none' | 'uploading' | 'has_resume'

export interface ResumeUploadCardProps {
  initialStatus: ResumeStatus
  initialInfo: string | null
  onStatus: (status: 'success' | 'error', message: string) => void
}

/**
 * Drag-and-drop resume upload. Posts to /api/resume/upload.
 *
 * Accepts PDF, Word (.docx), plain text (.txt) and Markdown (.md), 5MB limit.
 * The format list and the size cap come from lib/resume/import/formats.ts so
 * this component, the `accept` attribute and the server agree by construction.
 *
 * The check below is a courtesy, NOT a boundary: `accept` is a file-picker
 * filter that a drag-and-drop or a plain `curl` bypasses entirely. The route
 * validates the format again on its own — see app/api/resume/upload/route.ts.
 */
export function ResumeUploadCard({ initialStatus, initialInfo, onStatus }: ResumeUploadCardProps) {
  const [resumeStatus, setResumeStatus] = useState<ResumeStatus>(initialStatus)
  const [resumeInfo, setResumeInfo] = useState<string | null>(initialInfo)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleResumeUpload(file: File) {
    // Validate file type. Naming the way out matters more than naming the
    // failure: a user whose .doc is rejected needs to be told to save a .docx.
    if (isLegacyDoc(file.name, file.type)) {
      onStatus('error', 'Legacy .doc files are not supported — save it as .docx or PDF and try again')
      return
    }
    if (!detectResumeFormat(file.name, file.type)) {
      onStatus('error', `Unsupported file type. Upload ${SUPPORTED_FORMATS_SENTENCE}.`)
      return
    }

    // Validate file size
    if (file.size > RESUME_UPLOAD_MAX_BYTES) {
      onStatus('error', `File too large (max ${RESUME_UPLOAD_MAX_LABEL})`)
      return
    }

    setResumeStatus('uploading')
    const formData = new FormData()
    formData.append('resume', file)

    try {
      const response = await fetch('/api/resume/upload', {
        method: 'POST',
        body: formData,
      })

      const result = await response.json()
      if (result.success) {
        setResumeStatus('has_resume')
        // Show the method the server actually reports rather than mapping two
        // hard-coded strings and calling everything else "basic" — there are
        // now a format's worth of them (Word styles, Markdown, PDF text +
        // inference, LLM reformat), and a stale allow-list mislabels the good
        // ones as basic.
        const method = typeof result.extractionMethod === 'string' ? result.extractionMethod : null
        setResumeInfo(
          [result.wordCount ? `${result.wordCount} words` : null, method]
            .filter(Boolean)
            .join(' · ') || null
        )
        onStatus('success', result.message || 'Resume uploaded successfully')
      } else {
        setResumeStatus(resumeInfo ? 'has_resume' : 'none')
        onStatus('error', result.error || 'Failed to upload resume')
      }
    } catch {
      setResumeStatus(resumeInfo ? 'has_resume' : 'none')
      onStatus('error', 'Failed to upload resume')
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    const files = e.dataTransfer.files
    if (files.length > 0) {
      handleResumeUpload(files[0])
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (files && files.length > 0) {
      handleResumeUpload(files[0])
    }
  }

  return (
    <div>
      <label className="text-body font-medium text-foreground">Resume</label>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        accept={RESUME_UPLOAD_ACCEPT}
        className="hidden"
      />
      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'mt-1.5 cursor-pointer rounded-card border border-dashed p-6 text-center transition-colors',
          isDragging ? 'border-accent bg-accent-soft' : 'hover:bg-sunken/60',
          resumeStatus === 'has_resume' &&
            'border-emerald-300 bg-emerald-50/50 dark:border-emerald-500/30 dark:bg-emerald-500/5'
        )}
      >
        {resumeStatus === 'uploading' ? (
          <>
            <Loader2 className="mx-auto mb-2 h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-caption text-muted-foreground">Processing resume…</p>
          </>
        ) : resumeStatus === 'has_resume' ? (
          <>
            <FileText className="mx-auto mb-2 h-8 w-8 text-emerald-600 dark:text-emerald-400" />
            <p className="text-body font-medium text-emerald-700 dark:text-emerald-400">
              Resume uploaded
            </p>
            {resumeInfo && (
              <p className="mt-1 text-caption text-muted-foreground">{resumeInfo}</p>
            )}
            <p className="mt-2 text-caption text-accent-deep">Click to replace</p>
          </>
        ) : (
          <>
            <Upload className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
            <p className="text-body text-muted-foreground">
              Drag and drop your resume, or click to browse
            </p>
            <p className="mt-1 text-caption text-muted-foreground">
              {SUPPORTED_FORMATS_SENTENCE} — up to {RESUME_UPLOAD_MAX_LABEL}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
