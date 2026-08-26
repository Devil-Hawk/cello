'use client'

// /resume — the resume front door.
//
// WHY THIS PAGE EXISTS
//   There was no /resume. The only resume route was /resume/[jobId], and the
//   only link to it anywhere in the app was a button inside the job detail
//   modal — so reaching your own master document meant opening /jobs, finding a
//   job, opening its modal and clicking through, and typing /resume rendered
//   the 404. The four templates in lib/resume/templates.ts and the picker over
//   them were collateral damage: nearly unreachable too.
//
// WHAT IT IS
//   The BASE resume — the master document every tailored version is generated
//   from — plus the one thing you do next with it: pick a job to tailor for. It
//   needs no jobId. The base bucket is `?jobId=base` on /api/resume/documents
//   (the route maps both "base" and an absent jobId to the job_id IS NULL
//   bucket), and a save posts `jobId: null`.
//
// WHAT IT IS NOT
//   Not the tailoring studio. Generation, the ATS report and the
//   base-vs-tailored diff stay on /resume/[jobId], which is untouched and still
//   accepts jobId="base" for anyone holding that URL. This page deliberately
//   duplicates a little of that page's load/save shape rather than refactoring
//   a working studio out from under a route people have bookmarked.
//
// THE PERSISTENCE CONTRACT IS THE STUDIO'S (lib/resume/types.ts)
//   `content_json.markdown` is AUTHORED here; `content` — the plain text an ATS
//   actually reads — is DERIVED from it on the SERVER. So a save posts
//   `markdown` + `templateId` and never a `content` field, and every read goes
//   through resolveResumeMarkdown(), which falls back to `doc.content` for the
//   rows written before formatting existed (content_json === null is legal and
//   common: those rows are plain text, which is valid Markdown).

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ArrowRight, FileText, FileWarning, Loader2, Save, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
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

/** Rows in the "tailor for a job" list. Enough to choose from, not a second
 *  jobs page — /jobs is one link away at the foot of that card. */
const TAILOR_LIMIT = 8

interface DocumentsResponse {
  versions?: ResumeDocument[]
  error?: string
}

/** A job this resume can be tailored for, and whether it already has been. */
interface TailorTarget {
  jobId: string
  title: string
  company: string | null
  /** Newest saved version in that job's bucket, or null if never tailored. */
  tailoredVersion: number | null
}

/** Supabase embeds a to-one relation as an object but types it as either. */
function relatedName(
  rel: { name?: string | null } | { name?: string | null }[] | null | undefined
): string | null {
  const one = Array.isArray(rel) ? rel[0] : rel
  return one?.name ?? null
}

/** Read a fetch Response as JSON, tolerating non-JSON bodies (timeouts,
 *  gateway errors) the same way the studio page does. */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const rawText = await res.text()
  try {
    return rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null
  } catch {
    console.error('[resume] non-JSON response', { status: res.status, body: rawText.slice(0, 500) })
    throw new Error(
      res.status === 504
        ? 'The request timed out — try again.'
        : `Unexpected response from the server (HTTP ${res.status}).`
    )
  }
}

/**
 * The template a stored version was written with, normalised through the
 * registry so a retired or corrupted id can never break the page — exactly the
 * degradation getTemplate() exists to provide.
 */
function templateIdOf(doc: ResumeDocument | null | undefined): string {
  return doc ? getTemplate(getResumeTemplateId(doc.content_json)).id : DEFAULT_TEMPLATE_ID
}

/**
 * Jobs worth offering as tailoring targets: everything in the pipeline, plus
 * every job that already HAS a tailored version. That second half matters —
 * without it a version you spent a minute generating becomes unreachable the
 * moment the application leaves your pipeline, which is the same class of bug
 * this page exists to fix.
 */
async function loadTailorTargets(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<TailorTarget[]> {
  // resume_documents is not in the generated Database type (the codegen has
  // not picked up the Phase B tables), so it is read through an untyped view
  // of the same cookie-scoped client — the pattern jobs/page.tsx uses for
  // company_dossiers. RLS still scopes the rows; the explicit user_id
  // predicate is belt-and-braces, matching lib/resume/store.ts.
  const untyped = supabase as unknown as SupabaseClient

  const [appsRes, docsRes] = await Promise.all([
    supabase
      .from('applications')
      .select('job_id, updated_at, jobs(id, title, companies(name))')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(TAILOR_LIMIT),
    untyped
      .from('resume_documents')
      .select('job_id, version')
      .eq('user_id', userId)
      .not('job_id', 'is', null)
      .order('version', { ascending: false }),
  ])

  if (appsRes.error) throw new Error(appsRes.error.message)
  if (docsRes.error) throw new Error(docsRes.error.message)

  // Ordered version-desc, so the FIRST row seen for a job is its newest.
  const tailored = new Map<string, number>()
  for (const row of (docsRes.data ?? []) as { job_id: string | null; version: number }[]) {
    if (!row.job_id || tailored.has(row.job_id)) continue
    tailored.set(row.job_id, row.version)
  }

  const targets = new Map<string, TailorTarget>()
  for (const row of (appsRes.data ?? []) as unknown as {
    jobs: { id: string; title: string; companies: { name: string | null } | null } | null
  }[]) {
    const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs
    if (!job?.id || targets.has(job.id)) continue
    targets.set(job.id, {
      jobId: job.id,
      title: job.title,
      company: relatedName(job.companies),
      tailoredVersion: tailored.get(job.id) ?? null,
    })
  }

  const missing = [...tailored.keys()].filter((id) => !targets.has(id)).slice(0, TAILOR_LIMIT)
  if (missing.length > 0) {
    const { data } = await supabase.from('jobs').select('id, title, companies(name)').in('id', missing)
    for (const job of (data ?? []) as unknown as {
      id: string
      title: string
      companies: { name: string | null } | null
    }[]) {
      if (targets.has(job.id)) continue
      targets.set(job.id, {
        jobId: job.id,
        title: job.title,
        company: relatedName(job.companies),
        tailoredVersion: tailored.get(job.id) ?? null,
      })
    }
  }

  // Already-tailored first — you are coming back to those — then the rest in
  // pipeline order. Array.prototype.sort is stable, so each group keeps the
  // order it was inserted in.
  return [...targets.values()]
    .sort((a, b) => Number(b.tailoredVersion !== null) - Number(a.tailoredVersion !== null))
    .slice(0, TAILOR_LIMIT)
}

export default function ResumeHomePage() {
  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [versions, setVersions] = useState<ResumeDocument[]>([])
  /** profiles.resume_text — the uploaded resume, before anything is versioned.
   *  lib/resume/store.ts's own contract: resume_documents has zero rows until
   *  someone saves, so this is the only copy a fresh account has. */
  const [profileResumeText, setProfileResumeText] = useState('')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** The authored Markdown being edited. Never the derived plain text. */
  const [editBuffer, setEditBuffer] = useState('')
  const [templateId, setTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID)
  const [compareMarkdown, setCompareMarkdown] = useState<string | null>(null)
  const [compareLabel, setCompareLabel] = useState('')
  const [viewMode, setViewMode] = useState<ResumeWorkspaceMode>('edit')

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [targets, setTargets] = useState<TailorTarget[]>([])
  /** Non-fatal: the tailor list failing must never take the editor down with
   *  it, so it gets its own error rather than setting loadError. */
  const [targetsError, setTargetsError] = useState<string | null>(null)

  const selectedVersion = useMemo(
    () => versions.find((v) => v.id === selectedId) ?? null,
    [versions, selectedId]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        setLoadError('Not signed in.')
        return
      }

      const [docsRes, profileRes] = await Promise.all([
        fetch('/api/resume/documents?jobId=base'),
        supabase.from('profiles').select('resume_text').eq('id', user.id).maybeSingle(),
      ])

      const data = (await readJson(docsRes)) as DocumentsResponse | null
      if (!docsRes.ok) {
        throw new Error(data?.error ?? `Failed to load your resume (HTTP ${docsRes.status}).`)
      }

      const v = Array.isArray(data?.versions) ? (data!.versions as ResumeDocument[]) : []
      const resumeText = (
        (profileRes.data as { resume_text?: string | null } | null)?.resume_text ?? ''
      ).trim()

      setVersions(v)
      setProfileResumeText(resumeText)

      // Seeded here rather than in an effect: both halves of "what should be in
      // the editor" are already resolved at this point, so there is no window
      // where the buffer disagrees with what was just fetched.
      if (v.length > 0) {
        setSelectedId(v[0].id)
        setEditBuffer(resolveResumeMarkdown(v[0]))
        setTemplateId(templateIdOf(v[0]))
        if (v.length > 1) {
          setCompareMarkdown(resolveResumeMarkdown(v[1]))
          setCompareLabel(`v${v[1].version}`)
        } else {
          setCompareMarkdown(null)
        }
        setViewMode('edit')
      } else {
        setSelectedId(null)
        // Nothing versioned yet: open the uploaded resume (or an empty buffer
        // for an account with neither) so the first save promotes it into a
        // real base version instead of starting from a blank page.
        setEditBuffer(resumeText)
        setTemplateId(DEFAULT_TEMPLATE_ID)
        setCompareMarkdown(null)
        setViewMode('edit')
      }

      // Deliberately after the resume itself and never awaited into the same
      // try/catch outcome — see targetsError.
      try {
        setTargetsError(null)
        setTargets(await loadTailorTargets(supabase, user.id))
      } catch (err) {
        console.error('[resume] tailor targets failed', err)
        setTargets([])
        setTargetsError("Couldn't load the jobs you can tailor for.")
      }
    } catch (err) {
      console.error('[resume] load failed', err)
      setLoadError(err instanceof Error ? err.message : 'Failed to load your resume.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function selectVersion(id: string) {
    const idx = versions.findIndex((v) => v.id === id)
    if (idx === -1) return
    const v = versions[idx]
    setSelectedId(v.id)
    setEditBuffer(resolveResumeMarkdown(v))
    setTemplateId(templateIdOf(v))
    setSaveError(null)
    const older = versions[idx + 1]
    if (older) {
      setCompareMarkdown(resolveResumeMarkdown(older))
      setCompareLabel(`v${older.version}`)
      setViewMode('diff')
    } else {
      setCompareMarkdown(null)
      setViewMode('edit')
    }
  }

  // The best-known Markdown for "the base resume as it stands", falling all the
  // way back to profiles.resume_text. Plain text is valid Markdown, so no
  // conversion is needed on that fallback.
  const currentMarkdown = versions[0] ? resolveResumeMarkdown(versions[0]) : profileResumeText
  const hasResumeAtAll = currentMarkdown.trim().length > 0 || editBuffer.trim().length > 0

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
    // 'base' only for the very first version of the master document; every
    // later save is an edit of it. Same vocabulary the studio uses.
    const source: ResumeSource = selectedId ? 'edited' : 'base'
    try {
      const res = await fetch('/api/resume/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // markdown + templateId only — the server derives `content` with
        // markdownToPlainText(). See the header: the client must never author
        // the plain text an ATS reads.
        body: JSON.stringify({ action: 'save', jobId: null, markdown: editBuffer, templateId, source }),
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
      toast({ title: 'Saved', description: `Base resume saved as version ${doc.version}.` })
    } catch (err) {
      console.error('[resume] save failed', err)
      const message = err instanceof Error ? err.message : 'Save failed.'
      setSaveError(message)
      toast({ title: 'Save failed', description: message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {/* sr-only real h1 — see jobs/page.tsx's JobsPageSkeleton for why. */}
        <h1 className="sr-only">Resume — loading…</h1>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (loadError) {
    return (
      <EmptyState
        icon={FileWarning}
        title="Couldn't load your resume"
        headingLevel="h1"
        body={loadError}
        action={
          <Button size="sm" onClick={load}>
            Retry
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-title text-foreground">Resume</h1>
          <p className="mt-1 text-caption text-muted-foreground">
            Your master document — every tailored version starts from what&rsquo;s here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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

      {/* The no-resume path. The editor below still renders and still saves, so
          "write one here" is a real option — but an upload is the faster one,
          and Settings is where that lives. */}
      {!hasResumeAtAll && (
        <EmptyState
          icon={FileText}
          title="No resume on file yet"
          body="Upload one in Settings and it becomes your base resume — or write it below and save your first version."
          action={
            <Button asChild size="sm">
              <Link href="/settings">
                <Upload aria-hidden="true" className="h-3.5 w-3.5" />
                Upload in Settings
              </Link>
            </Button>
          }
        />
      )}

      <section className="space-y-3">
        <h2 className="sr-only">Base resume</h2>
        <div className="grid gap-6 lg:grid-cols-[200px_1fr] lg:items-start">
          <aside className="lg:sticky lg:top-4">
            <div className="mb-2 text-label uppercase text-muted-foreground">Versions</div>
            <VersionList versions={versions} selectedId={selectedId} onSelect={selectVersion} />
          </aside>

          <div className="min-w-0">
            <ResumeWorkspace
              markdown={editBuffer}
              onMarkdownChange={setEditBuffer}
              templateId={templateId}
              onTemplateChange={setTemplateId}
              compareMarkdown={compareMarkdown}
              compareLabel={compareLabel}
              currentLabel={selectedVersion ? `v${selectedVersion.version} (current draft)` : 'Current draft'}
              mode={viewMode}
              onModeChange={setViewMode}
            />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="font-display text-section text-foreground">Tailor for a job</h2>
          <p className="mt-1 text-caption text-muted-foreground">
            A tailored version starts from this base resume and rewrites it against one job&rsquo;s
            description — scored before and after, and saved separately from the master.
          </p>
        </div>

        {targetsError ? (
          <Card className="p-5">
            <p className="text-caption text-muted-foreground">{targetsError}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={load}>
              Retry
            </Button>
          </Card>
        ) : targets.length === 0 ? (
          <Card className="p-5">
            <p className="text-caption text-muted-foreground">
              Nothing to tailor for yet — add a job to your pipeline, or open any job and start from
              there.
            </p>
            <Button size="sm" variant="outline" className="mt-3" asChild>
              <Link href="/jobs">
                Browse jobs
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </Card>
        ) : (
          <Card className="divide-y overflow-hidden">
            {targets.map((target) => (
              <div key={target.jobId} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body text-foreground">{target.title}</p>
                  <p className="truncate text-caption text-muted-foreground">
                    {target.company ?? 'Unknown company'}
                  </p>
                </div>
                {target.tailoredVersion !== null && (
                  // Same tone version-list.tsx gives a tailored version, so the
                  // two surfaces agree about what "tailored" looks like.
                  <Badge tone="accent">v{target.tailoredVersion}</Badge>
                )}
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/resume/${target.jobId}`}>
                    {target.tailoredVersion !== null ? 'Open' : 'Tailor'}
                  </Link>
                </Button>
              </div>
            ))}
            <div className="px-4 py-3">
              <Link
                href="/jobs"
                className="inline-flex items-center gap-1.5 text-caption font-medium text-muted-foreground hover:text-foreground"
              >
                Browse all jobs
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            </div>
          </Card>
        )}
      </section>
    </div>
  )
}
