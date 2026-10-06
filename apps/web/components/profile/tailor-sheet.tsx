'use client'

// Tailor for a role: pick a saved role or application, run Tailor resume, and hand back the new
// version with Cello's read of it. The rewrite itself is the existing `generate` action.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ResumeDocument } from '@/lib/resume/types'
import type { TailorReport } from './tailor-read'
import type { TailorTarget } from './versions'

export interface TailorSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  targets: TailorTarget[]
  /** A role to start on, from a link. */
  preselect?: string | null
  /** False when no model can run: the sheet says so and does not offer to run. */
  hasModel: boolean
  onDone: (result: { document: ResumeDocument; report: TailorReport }) => void
}

export function TailorSheet({ open, onOpenChange, targets, preselect, hasModel, onDone }: TailorSheetProps) {
  const [jobId, setJobId] = useState<string | null>(preselect ?? null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && preselect) setJobId(preselect)
  }, [open, preselect])

  async function run() {
    if (!jobId || running) return
    setRunning(true)
    setError(null)
    try {
      const res = await fetch('/api/resume/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', jobId }),
      })
      const data = (await res.json().catch(() => null)) as { document?: ResumeDocument; optimization?: TailorReport; error?: string } | null
      if (!res.ok || !data?.document || !data.optimization) {
        setError(res.status === 504 ? 'That took too long. Try again.' : (data?.error ?? 'Could not tailor your resume. Try again.'))
        return
      }
      onDone({ document: data.document, report: data.optimization })
      onOpenChange(false)
    } catch {
      setError('Could not tailor your resume. Try again.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tailor for a role</DialogTitle>
          <DialogDescription>Cello rewrites your base resume for one role and saves it as its own version. Your base resume stays as it is.</DialogDescription>
        </DialogHeader>

        {targets.length === 0 ? (
          <p className="text-body text-muted-foreground">
            Save a role or start an application and it shows here.{' '}
            <Link href="/jobs" className="underline underline-offset-4">
              Find roles
            </Link>
          </p>
        ) : (
          <fieldset className="space-y-1" disabled={running}>
            <legend className="sr-only">Role to tailor for</legend>
            {targets.map((t) => (
              <label key={t.jobId} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-control px-2 py-2 hover:bg-sunken/60">
                <input type="radio" name="tailor-role" className="mt-1" checked={jobId === t.jobId} onChange={() => setJobId(t.jobId)} />
                <span className="min-w-0">
                  <span className="block break-words text-body font-medium text-foreground">{t.title}</span>
                  <span className="block break-words text-caption text-muted-foreground">
                    {t.company ?? 'Employer not named'}
                    {t.tailoredVersion !== null ? `, tailored before as version ${t.tailoredVersion}` : ''}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {!hasModel && (
          <p className="text-caption text-muted-foreground">
            Tailoring needs a model.{' '}
            <Link href="/settings?tab=model" className="underline underline-offset-4">
              Choose one in Settings
            </Link>
          </p>
        )}
        {running && (
          <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            Tailoring. This takes up to a minute.
          </p>
        )}
        {error && (
          <p role="alert" className="text-caption text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button className="min-h-11" onClick={run} disabled={!jobId || running || !hasModel}>
            Tailor resume
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
