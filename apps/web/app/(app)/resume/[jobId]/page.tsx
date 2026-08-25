'use client'

// The resume studio.
//
// WHAT CHANGED AND WHAT DID NOT
//   The buffer this page holds is now MARKDOWN — the authored document — instead
//   of the plain text an ATS reads. Everything else about the page is unchanged
//   on purpose: append-only versions, the version rail, the diff, the generate
//   flow and its ATS report are load-bearing product, not scaffolding around the
//   editor, and none of them assume plain text.
//
// THE ONE RULE THIS PAGE MUST NOT BREAK (lib/resume/types.ts)
//   `content_json.markdown` is AUTHORED; `content` is DERIVED from it by
//   markdownToPlainText() on the SERVER. This client therefore posts `markdown`
//   and `templateId` and never a `content` field. If both ends could author, the
//   two representations drift — and the drifted one is the copy the employer's
//   parser actually reads. Reading back goes through resolveResumeMarkdown(),
//   which falls back to `doc.content` for every row written before formatting
//   existed (content_json === null is legal and common: those rows are plain
//   text, which is valid Markdown).
//
// THE DIFF COMPARES MARKDOWN, NOT PLAIN TEXT
//   Diffing the derived text would hide exactly the edits this feature adds:
//   promoting a line to a section heading, or bolding a job title, would both
//   show up as "no change". So every comparison below is
//   resolveResumeMarkdown(older) against the live buffer.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, FileWarning, Loader2, Save, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
import { matchTone } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ResumeDownloadMenu } from '@/components/resume/resume-download-menu'
import { ResumeWorkspace, type ResumeWorkspaceMode } from '@/components/resume/resume-workspace'
import { VersionList } from '@/components/resume/version-list'
import { DEFAULT_TEMPLATE_ID, getTemplate } from '@/lib/resume/templates'
import {
  getResumeTemplateId,
  resolveResumeMarkdown,
  type ResumeDocument,
  type ResumeSource,
} from '@/lib/resume/types'
import type { ResumeOptimizerResult } from '@/lib/harness/agents/resume_optimizer'

interface OptimizationState {
  /** The resume_documents id this report describes — a generate result goes stale once you select away from it. */
  forId: string
  report: ResumeOptimizerResult
}

interface JobMeta {
  title: string
  company: string | null
}

interface DocumentsResponse {
  versions?: ResumeDocument[]
  base?: ResumeDocument | null
  error?: string
}

/** Read a fetch Response as JSON, tolerating non-JSON bodies (timeouts, gateway errors) like the optimizer panel does. */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const rawText = await res.text()
  try {
    return rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null
  } catch (parseErr) {
    console.error('[resume-studio] non-JSON response', { status: res.status, body: rawText.slice(0, 500) })
    throw new Error(
      res.status === 504
        ? 'The request timed out — try again.'
        : `Unexpected response from the server (HTTP ${res.status}).`
    )
  }
}

/**
 * The template a stored version was written with, normalised through the
 * registry so a retired or corrupted id can never break the studio — exactly the
 * degradation getTemplate() exists to provide.
 */
function templateIdOf(doc: ResumeDocument | null | undefined): string {
  return doc ? getTemplate(getResumeTemplateId(doc.content_json)).id : DEFAULT_TEMPLATE_ID
}

function ScoreDial({ score, label }: { score: number; label: string }) {
  const tone = matchTone(score)
  const toneClass =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'bad'
          ? 'text-red-600 dark:text-red-400'
          : 'text-muted-foreground'
  return (
    <div className="text-center">
      <div className={cn('font-display text-stat tabular-nums', toneClass)}>{score}</div>
      <div className="text-label uppercase text-muted-foreground">{label}</div>
    </div>
  )
}

/** Right-rail readout for a fresh 'generate' result: score before/after, keyword chips, format issues. */
function OptimizationReport({ report }: { report: ResumeOptimizerResult }) {
  const delta = report.rescore.atsScore - report.atsScore
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center gap-4 rounded-control bg-sunken/60 py-3">
        <ScoreDial score={report.atsScore} label="Before" />
        <span aria-hidden="true" className="text-muted-foreground">
          →
        </span>
        <ScoreDial score={report.rescore.atsScore} label="After" />
      </div>
      {delta !== 0 && (
        <div className="text-center">
          <Badge tone={delta > 0 ? 'good' : 'bad'}>
            {delta > 0 ? '+' : ''}
            {delta} ATS points
          </Badge>
        </div>
      )}

      {report.missingKeywords.length > 0 && (
        <div>
          <div className="mb-1.5 text-label uppercase text-muted-foreground">Missing keywords</div>
          <div className="flex flex-wrap gap-1.5">
            {report.missingKeywords.map((k) => (
              <span
                key={k}
                className="rounded-full bg-amber-100 px-2 py-0.5 text-caption text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
              >
                {k}
              </span>
            ))}
          </div>
        </div>
      )}

      {report.matchedKeywords.length > 0 && (
        <div>
          <div className="mb-1.5 text-label uppercase text-muted-foreground">Already covered</div>
          <div className="flex flex-wrap gap-1.5">
            {report.matchedKeywords.slice(0, 16).map((k) => (
              <span
                key={k}
                className="rounded-full bg-emerald-100 px-2 py-0.5 text-caption text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
              >
                {k}
              </span>
            ))}
          </div>
        </div>
      )}

      {report.formatIssues.length > 0 && (
        <div>
          <div className="mb-1.5 text-label uppercase text-muted-foreground">Format fixes</div>
          <ul className="space-y-1 text-caption text-muted-foreground">
            {report.formatIssues.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                <span aria-hidden="true">•</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] leading-snug text-muted-foreground">
        This rewrite only reorganizes and rephrases your real experience — it never invents employers,
        titles, dates, or skills.
      </p>
    </div>
  )
}

export default function ResumeStudioPage() {
  const params = useParams<{ jobId: string }>()
  const rawJobId = typeof params?.jobId === 'string' ? params.jobId : Array.isArray(params?.jobId) ? params.jobId[0] : ''
  const isBase = rawJobId === 'base'
  // The bucket key the API/store expect: null selects the base resume, a uuid selects a job's tailored bucket.
  const apiJobId = isBase ? null : rawJobId

  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [jobNotFound, setJobNotFound] = useState(false)
  const [jobMeta, setJobMeta] = useState<JobMeta | null>(null)

  const [versions, setVersions] = useState<ResumeDocument[]>([])
  const [baseDoc, setBaseDoc] = useState<ResumeDocument | null>(null)
  const [profileResumeText, setProfileResumeText] = useState('')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** The authored Markdown being edited. Never the derived plain text. */
  const [editBuffer, setEditBuffer] = useState('')
  const [templateId, setTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID)
  const [compareMarkdown, setCompareMarkdown] = useState<string | null>(null)
  const [compareLabel, setCompareLabel] = useState('')
  const [viewMode, setViewMode] = useState<ResumeWorkspaceMode>('edit')
  const [optimization, setOptimization] = useState<OptimizationState | null>(null)

  const [generating, setGenerating] = useState(false)
  const [generateElapsedMs, setGenerateElapsedMs] = useState(0)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const selectedVersion = useMemo(
    () => versions.find((v) => v.id === selectedId) ?? null,
    [versions, selectedId]
  )

  // The best-known Markdown for "the resume as it stands right now", falling
  // back all the way to profiles.resume_text per lib/resume/store.ts's own
  // contract (resume_documents has zero rows until someone saves a version).
  // Plain text is valid Markdown, so the fallback needs no conversion.
  const currentMarkdown = versions[0]
    ? resolveResumeMarkdown(versions[0])
    : baseDoc
      ? resolveResumeMarkdown(baseDoc)
      : profileResumeText

  useEffect(() => {
    if (!generating) {
      setGenerateElapsedMs(0)
      return
    }
    const start = Date.now()
    const id = setInterval(() => setGenerateElapsedMs(Date.now() - start), 250)
    return () => clearInterval(id)
  }, [generating])

  const loadData = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setJobNotFound(false)
    try {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        setLoadError('Not signed in.')
        return
      }

      const tasks: Promise<void>[] = []

      tasks.push(
        (async () => {
          const { data: profile } = await supabase
            .from('profiles')
            .select('resume_text')
            .eq('id', user.id)
            .maybeSingle()
          setProfileResumeText(((profile as { resume_text?: string | null } | null)?.resume_text ?? '').trim())
        })()
      )

      if (apiJobId) {
        tasks.push(
          (async () => {
            const { data: job } = await supabase
              .from('jobs')
              .select('id, title, companies(name)')
              .eq('id', apiJobId)
              .maybeSingle()
            if (!job) {
              setJobNotFound(true)
              return
            }
            const companyRel = (job as { companies?: { name?: string } | { name?: string }[] | null }).companies
            const companyName = Array.isArray(companyRel) ? companyRel[0]?.name : companyRel?.name
            setJobMeta({ title: (job as { title: string }).title, company: companyName ?? null })
          })()
        )
      }

      const docsUrl = apiJobId ? `/api/resume/documents?jobId=${encodeURIComponent(apiJobId)}` : '/api/resume/documents'
      tasks.push(
        (async () => {
          const res = await fetch(docsUrl)
          const data = (await readJson(res)) as DocumentsResponse | null
          if (!res.ok) {
            throw new Error(data?.error ?? `Failed to load resume versions (HTTP ${res.status}).`)
          }
          const v = Array.isArray(data?.versions) ? (data!.versions as ResumeDocument[]) : []
          const base = (data?.base as ResumeDocument | null | undefined) ?? null
          setVersions(v)
          setBaseDoc(base)

          if (v.length > 0) {
            setSelectedId(v[0].id)
            setEditBuffer(resolveResumeMarkdown(v[0]))
            setTemplateId(templateIdOf(v[0]))
            if (v.length > 1) {
              setCompareMarkdown(resolveResumeMarkdown(v[1]))
              setCompareLabel(`v${v[1].version}`)
              setViewMode('diff')
            } else {
              setCompareMarkdown(null)
              setViewMode('edit')
            }
          } else {
            setSelectedId(null)
            setCompareMarkdown(null)
            setViewMode('edit')
            // No version of our own yet: inherit whatever the base resume was
            // last formatted with, so a tailored resume starts out looking like
            // the master document rather than resetting to the default.
            setTemplateId(templateIdOf(base))
          }
        })()
      )

      await Promise.all(tasks)
    } catch (err) {
      console.error('[resume-studio] load failed', err)
      setLoadError(err instanceof Error ? err.message : 'Failed to load the resume studio.')
    } finally {
      setLoading(false)
    }
  }, [apiJobId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // editBuffer defaults to the current resume once loaded, when there is no
  // saved version yet to seed it from (first-run state).
  useEffect(() => {
    if (!loading && versions.length === 0) {
      setEditBuffer(currentMarkdown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, versions.length, currentMarkdown])

  function selectVersion(id: string) {
    const idx = versions.findIndex((v) => v.id === id)
    if (idx === -1) return
    const v = versions[idx]
    setSelectedId(v.id)
    setEditBuffer(resolveResumeMarkdown(v))
    setTemplateId(templateIdOf(v))
    setGenerateError(null)
    setSaveError(null)
    const older = versions[idx + 1]
    if (older) {
      setCompareMarkdown(resolveResumeMarkdown(older))
      setCompareLabel(`v${older.version}`)
      setViewMode('diff')
    } else if (!isBase && baseDoc && baseDoc.id !== v.id) {
      setCompareMarkdown(resolveResumeMarkdown(baseDoc))
      setCompareLabel('Base resume')
      setViewMode('diff')
    } else {
      setCompareMarkdown(null)
      setViewMode('edit')
    }
  }

  async function generate() {
    if (!apiJobId || generating) return
    setGenerating(true)
    setGenerateError(null)
    const beforeMarkdown = editBuffer || currentMarkdown
    const beforeLabel = selectedVersion ? `v${selectedVersion.version}` : 'Current resume'
    try {
      const res = await fetch('/api/resume/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', jobId: apiJobId }),
      })
      const data = await readJson(res)
      if (!res.ok || !data?.document) {
        throw new Error((data?.error as string | undefined) ?? `Generation failed (HTTP ${res.status}).`)
      }
      const doc = data.document as ResumeDocument
      const optimizationResult = data.optimization as ResumeOptimizerResult
      setVersions((prev) => [doc, ...prev])
      setSelectedId(doc.id)
      setEditBuffer(resolveResumeMarkdown(doc))
      // A generated version keeps the template the user had chosen unless the
      // rewrite stored one of its own.
      setTemplateId(getResumeTemplateId(doc.content_json) ? templateIdOf(doc) : templateId)
      setCompareMarkdown(beforeMarkdown)
      setCompareLabel(beforeLabel)
      setViewMode('diff')
      setOptimization({ forId: doc.id, report: optimizationResult })
      toast({
        title: 'Tailored version generated',
        description: `ATS score ${optimizationResult.atsScore} → ${optimizationResult.rescore.atsScore}. Review the diff before saving edits.`,
      })
    } catch (err) {
      console.error('[resume-studio] generate failed', err)
      const message = err instanceof Error ? err.message : 'Resume generation failed.'
      setGenerateError(message)
      toast({ title: 'Generation failed', description: message, variant: 'destructive' })
    } finally {
      setGenerating(false)
    }
  }

  // A template change is a real, savable change: it is persisted in
  // content_json.templateId and it changes what the export looks like.
  const savedMarkdown = selectedVersion ? resolveResumeMarkdown(selectedVersion) : currentMarkdown
  const templateChanged = selectedVersion ? templateId !== templateIdOf(selectedVersion) : false
  const hasChanges = editBuffer.trim() !== savedMarkdown.trim() || templateChanged
  const canSave = editBuffer.trim().length > 0 && (versions.length === 0 || hasChanges)

  async function save() {
    if (!canSave || saving) return
    setSaving(true)
    setSaveError(null)
    const priorMarkdown = selectedVersion
      ? resolveResumeMarkdown(selectedVersion)
      : versions.length === 0
        ? null
        : currentMarkdown
    const priorLabel = selectedVersion ? `v${selectedVersion.version}` : 'Current resume'
    const source: ResumeSource = selectedId ? 'edited' : isBase ? 'base' : 'edited'
    try {
      const res = await fetch('/api/resume/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // markdown + templateId only: the server derives `content` with
        // markdownToPlainText() and builds content_json with
        // toResumeContentJson(). See the header — the client must never author
        // the plain text an ATS reads.
        body: JSON.stringify({ action: 'save', jobId: apiJobId, markdown: editBuffer, templateId, source }),
      })
      const data = await readJson(res)
      if (!res.ok || !data?.document) {
        throw new Error((data?.error as string | undefined) ?? `Save failed (HTTP ${res.status}).`)
      }
      const doc = data.document as ResumeDocument
      setVersions((prev) => [doc, ...prev])
      setSelectedId(doc.id)
      setEditBuffer(resolveResumeMarkdown(doc))
      setTemplateId(templateIdOf(doc))
      if (priorMarkdown !== null) {
        setCompareMarkdown(priorMarkdown)
        setCompareLabel(priorLabel)
        setViewMode('diff')
      } else {
        setCompareMarkdown(null)
        setViewMode('edit')
      }
      setOptimization(null)
      toast({ title: 'Saved', description: `Saved as version ${doc.version}.` })
    } catch (err) {
      console.error('[resume-studio] save failed', err)
      const message = err instanceof Error ? err.message : 'Save failed.'
      setSaveError(message)
      toast({ title: 'Save failed', description: message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const backHref = isBase ? '/settings' : '/jobs'
  const backLabel = isBase ? 'Settings' : 'All jobs'

  if (loading) {
    return (
      <div className="space-y-4">
        {/* sr-only real h1 — see jobs/page.tsx's JobsPageSkeleton for why. */}
        <h1 className="sr-only">Resume studio — loading…</h1>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (loadError) {
    return (
      <EmptyState
        icon={FileWarning}
        title="Couldn't load the resume studio"
        headingLevel="h1"
        body={loadError}
        action={
          <Button size="sm" onClick={loadData}>
            Retry
          </Button>
        }
      />
    )
  }

  if (jobNotFound) {
    return (
      <EmptyState
        icon={FileWarning}
        title="Job not found"
        body="This job no longer exists or isn't yours to view."
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/jobs">Back to jobs</Link>
          </Button>
        }
      />
    )
  }

  const isFirstRun = !isBase && versions.length === 0
  const hasResumeAtAll = currentMarkdown.trim().length > 0
  const showOptimization = !!optimization && optimization.forId === selectedId

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {backLabel}
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-title text-foreground">
            {isBase ? 'Base resume' : jobMeta?.title ?? 'Resume'}
          </h1>
          <p className="mt-1 text-caption text-muted-foreground">
            {isBase ? 'Your master document — versions here seed every tailored resume.' : jobMeta?.company ?? ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isBase && !isFirstRun && (
            <Button size="sm" variant="outline" onClick={generate} disabled={generating}>
              {generating ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {generating ? `Generating… ${Math.floor(generateElapsedMs / 1000)}s` : 'Regenerate tailored version'}
            </Button>
          )}
          <ResumeDownloadMenu
            documentId={selectedId}
            templateId={templateId}
            filenameBase={`resume-v${selectedVersion?.version ?? 1}`}
            hasUnsavedChanges={hasChanges}
          />
          <Button size="sm" onClick={save} disabled={!canSave || saving}>
            {saving ? (
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {saving ? 'Saving…' : 'Save as new version'}
          </Button>
        </div>
      </div>

      {saveError && <p className="text-caption text-red-600 dark:text-red-400">{saveError}</p>}

      {isFirstRun && (
        <div className="rounded-card border p-5">
          <div className="mb-1 flex items-center gap-2">
            <Sparkles aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-body font-medium text-foreground">Generate a tailored version</h2>
          </div>
          <p className="mb-3 text-caption text-muted-foreground">
            Runs three model passes — scores your current resume against this job, rewrites it to close
            the gaps without inventing anything, then rescores the rewrite. Takes about a minute.
          </p>
          <Button onClick={generate} disabled={generating || !hasResumeAtAll}>
            {generating ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles aria-hidden="true" className="h-4 w-4" />
            )}
            {generating
              ? `Generating… ${Math.floor(generateElapsedMs / 1000)}s elapsed`
              : 'Generate tailored version'}
          </Button>
          {!hasResumeAtAll && (
            <p className="mt-2 text-caption text-muted-foreground">
              <Link href="/settings" className="font-medium text-accent-deep hover:underline">
                Upload a resume in Settings
              </Link>{' '}
              first.
            </p>
          )}
          {generateError && <p className="mt-2 text-caption text-red-600 dark:text-red-400">{generateError}</p>}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[200px_1fr_280px] lg:items-start">
        <aside className="lg:sticky lg:top-4">
          <div className="mb-2 text-label uppercase text-muted-foreground">Versions</div>
          <VersionList versions={versions} selectedId={selectedId} onSelect={selectVersion} />
        </aside>

        <section className="min-w-0">
          <ResumeWorkspace
            // Before anything is saved for this job there is nothing to edit
            // here yet — show the resume we do have, typeset, and let the
            // generate card above be the next step.
            readOnly={isFirstRun}
            markdown={isFirstRun ? currentMarkdown : editBuffer}
            onMarkdownChange={setEditBuffer}
            templateId={templateId}
            onTemplateChange={setTemplateId}
            compareMarkdown={compareMarkdown}
            compareLabel={compareLabel}
            currentLabel={selectedVersion ? `v${selectedVersion.version} (current draft)` : 'Current draft'}
            mode={viewMode}
            onModeChange={setViewMode}
          />
        </section>

        <aside className="min-w-0 space-y-4">
          {showOptimization && optimization ? (
            <OptimizationReport report={optimization.report} />
          ) : !isBase && versions.length > 0 ? (
            <p className="text-caption text-muted-foreground">
              Run &ldquo;Regenerate tailored version&rdquo; to see a fresh ATS score, keyword gaps, and
              format fixes for the selected version.
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
