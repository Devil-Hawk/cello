'use client'

// Profile: what Cello knows about you, your resume with its versions, and the material and
// accounts Cello uses on your behalf. The page reads everything on the server and passes it in;
// this component holds only what the person is doing right now (an open editor, a sheet).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResumeEditor } from '@/components/resume/editor/resume-editor'
import { saveResumeVersion } from '@/components/resume/editor/save-resume'
import type { EditorCompare } from '@/components/resume/editor/types'
import { ResumeImportDialog } from '@/components/resume/import-dialog'
import { ResumeDownloadMenu } from '@/components/resume/resume-download-menu'
import { ResumePreview } from '@/components/resume/resume-preview'
import { TemplatePicker } from '@/components/resume/template-picker'
import { SourcesTab } from '@/components/settings/sources-tab'
import { formatFixes, resumeHealth, wordCount } from '@/lib/resume/format-fixes'
import { resumeToPlainText } from '@/lib/resume/render'
import { resolveResume, resolveResumeMarkdown } from '@/lib/resume/resolve'
import { DEFAULT_TEMPLATE_ID, getTemplate } from '@/lib/resume/templates'
import { getResumeTemplateId, type ResumeDocument } from '@/lib/resume/types'
import { ApplicationIdentityCard } from './application-identity'
import { ApplyCredentialsCard } from './employer-accounts'
import { FactsGroup } from './facts-group'
import type { Fact } from './facts'
import { TailorRead, type TailorReport } from './tailor-read'
import { TailorSheet } from './tailor-sheet'
import { versionLabel, type TailorTarget, type VersionRow } from './versions'
import { VersionsGroup } from './versions-group'

export interface ProfileViewProps {
  facts: Fact[]
  versions: VersionRow[]
  /** profiles.resume_text, for an account that has text but no saved version yet. */
  fallbackText: string
  targets: TailorTarget[]
  /** True when a model can run, for Tailor. */
  hasModel: boolean
  /** A role to open Tailor on, from a link. */
  openTailor?: string | null
  /** Reloads what the page read, after something was saved or deleted. */
  refresh?: () => void
  onStatus?: (status: 'success' | 'error', message: string) => void
  /** Saves a correction. Returns what went wrong, or null. */
  onCorrect: (fact: Fact, raw: string) => Promise<string | null>
}

/** An editor opened on one version (or on the text an account has before any version). */
interface Session {
  key: string
  jobId: string | null
  markdown: string
  templateId: string
  label: string
  compare: EditorCompare | null
  report: TailorReport | null
}

const templateOf = (doc: ResumeDocument | null) => (doc ? getTemplate(getResumeTemplateId(doc.content_json)).id : DEFAULT_TEMPLATE_ID)

function Group({ title, count, defaultOpen, children }: { title: string; count?: number | string; defaultOpen?: boolean; children: ReactNode }) {
  // ponytail: a native details element until PG0's Disclosure is on the base; swap at the rebase
  return (
    <details open={defaultOpen} className="group border-t">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <h2 className="font-display text-title text-foreground">{title}</h2>
        {count !== undefined && <span className="text-caption text-muted-foreground">{count}</span>}
        <ChevronDown aria-hidden="true" className="ml-auto h-[18px] w-[18px] transition-transform group-open:rotate-180" />
      </summary>
      <div className="pb-6">{children}</div>
    </details>
  )
}

export function ProfileView({ facts, versions, fallbackText, targets, hasModel, openTailor, refresh, onStatus, onCorrect }: ProfileViewProps) {
  const base = useMemo(() => versions.filter((v) => v.job_id === null).reduce<VersionRow | null>((a, b) => (!a || b.version > a.version ? b : a), null), [versions])
  const baseMarkdown = base ? resolveResumeMarkdown(base) : fallbackText.trim()
  const savedTemplate = templateOf(base)

  const [templateId, setTemplateId] = useState(savedTemplate)
  const [session, setSession] = useState<Session | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [tailorOpen, setTailorOpen] = useState(Boolean(openTailor))
  const editorRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (session) editorRef.current?.focus()
  }, [session])

  const status = onStatus ?? (() => undefined)
  const plain = useMemo(() => (base ? resumeToPlainText(resolveResume(base)) : fallbackText), [base, fallbackText])
  const words = wordCount(plain)
  const health = resumeHealth(words)
  const fixes = useMemo(() => (base ? formatFixes(resolveResume(base), plain) : []), [base, plain])

  function open(v: VersionRow, compare: VersionRow | null) {
    setSession({
      key: `${v.id}:${compare ? 'compare' : 'open'}`,
      jobId: v.job_id,
      markdown: resolveResumeMarkdown(v),
      templateId: templateOf(v),
      label: `Version ${v.version}`,
      compare: compare ? { label: versionLabel(compare), markdown: resolveResumeMarkdown(compare) } : null,
      report: null,
    })
  }

  function edit() {
    if (base) return open(base, null)
    setSession({ key: 'text', jobId: null, markdown: baseMarkdown, templateId, label: 'Your resume text', compare: null, report: null })
  }

  async function remove(v: VersionRow): Promise<string | null> {
    try {
      const res = await fetch('/api/resume/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: v.id }),
      })
      if (!res.ok) return 'Could not delete that version.'
      if (session?.key.startsWith(v.id)) setSession(null)
      refresh?.()
      return null
    } catch {
      return 'Could not delete that version.'
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-section text-foreground">Profile</h1>
        <p className="mt-1 text-body text-muted-foreground">What Cello uses to find roles and write for you. Correct anything that is wrong.</p>
      </header>

      {session && (
        <section ref={editorRef} tabIndex={-1} aria-label="Resume editor" className="space-y-4 rounded-card border p-4 focus:outline-none sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-title text-foreground">{session.label}</h2>
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setSession(null)}>
              Close editor
            </Button>
          </div>
          {session.report && <TailorRead report={session.report} />}
          <ResumeEditor
            key={session.key}
            markdown={session.markdown}
            versionLabel={session.label}
            templateId={session.templateId}
            compare={session.compare}
            defaultMode={session.compare ? 'diff' : 'edit'}
            onSave={async (draft) => {
              const result = await saveResumeVersion({ jobId: session.jobId, ...draft })
              if (result.ok) refresh?.()
              return result
            }}
          />
        </section>
      )}

      <div>
        {facts.length > 0 && (
          <Group title="What Cello knows about you" count={facts.length}>
            <FactsGroup facts={facts} onCorrect={onCorrect} />
          </Group>
        )}

        <Group title="Your resume" defaultOpen>
          {baseMarkdown ? (
            <div className="space-y-5">
              <div>
                <p className="text-body text-foreground">{health ?? `${words.toLocaleString('en-US')} words.`}</p>
                {fixes.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-caption text-muted-foreground">
                    {fixes.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" className="min-h-11" onClick={edit}>
                  Edit resume
                </Button>
                <Button type="button" variant="outline" className="min-h-11" onClick={() => setTailorOpen(true)}>
                  Tailor for a role
                </Button>
                <ResumeDownloadMenu documentId={base?.id ?? null} templateId={templateId} filenameBase="resume" hasUnsavedChanges={templateId !== savedTemplate} className="min-h-11" />
                <Button type="button" variant="ghost" className="min-h-11" onClick={() => setImportOpen(true)}>
                  Replace your resume
                </Button>
              </div>
              <TemplatePicker value={templateId} onChange={setTemplateId} />
              <ResumePreview markdown={baseMarkdown} templateId={templateId} className="h-[420px]" aria-label="Preview of your resume in this template" />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-body text-foreground">Add your resume: paste it, or upload a PDF, Word file or photo.</p>
              <Button type="button" className="min-h-11" onClick={() => setImportOpen(true)}>
                Add your resume
              </Button>
            </div>
          )}
        </Group>

        {versions.length > 0 && (
          <Group title="Versions" count={versions.length}>
            <VersionsGroup versions={versions} currentBaseId={base?.id ?? null} onOpen={open} onDelete={remove} />
          </Group>
        )}

        <Group title="Your material">
          <p className="text-body text-muted-foreground">For letters and answers, not your resume.</p>
          <details className="mb-3 mt-1 text-caption text-muted-foreground">
            <summary className="flex min-h-11 cursor-pointer items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Learn more</summary>
            <p>What your resume has no room for. Cello uses it in letters, answers and messages, and puts it on your resume only when you add it.</p>
          </details>
          {/* ponytail: the Sources tab rendered as it is; restyle after the Settings page is rebuilt */}
          <SourcesTab onStatus={status} />
        </Group>

        <Group title="On your applications">
          <div className="space-y-8">
            <ApplicationIdentityCard onStatus={status} />
            <ApplyCredentialsCard onStatus={status} />
          </div>
        </Group>
      </div>

      <ResumeImportDialog open={importOpen} onOpenChange={setImportOpen} templateId={templateId} onSaved={refresh} />
      <TailorSheet
        open={tailorOpen}
        onOpenChange={setTailorOpen}
        targets={targets}
        preselect={openTailor}
        hasModel={hasModel}
        onDone={({ document, report }) => {
          setSession({
            key: document.id,
            jobId: document.job_id,
            markdown: resolveResumeMarkdown(document),
            templateId: templateOf(document),
            label: `Version ${document.version}`,
            compare: baseMarkdown ? { label: 'Base resume', markdown: baseMarkdown } : null,
            report,
          })
          refresh?.()
        }}
      />
    </div>
  )
}
