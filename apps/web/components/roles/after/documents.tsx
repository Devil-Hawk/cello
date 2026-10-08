'use client'

// The record after acting, group two: the documents for this role (blueprint 4.6). The resume version with why it
// was made, how it was checked and Compare to the base resume; the letter; and, folded under the version sent, each
// attempt: where, when, who sent it, the documents by version, the answers used, the site's confirmation, the cost,
// and "I did not actually send this". Read with the person's own session; nothing here sends anything.

import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { Key } from '@/components/ui/key'
import { ago } from '@/lib/network/format'
import { readType } from '@/lib/artifacts/types'
import type { ApplicationAttempt, AttemptOutcome } from '@/lib/applications/types'
import { act } from './data'
import { changedLines } from './logic'

export interface Doc {
  id: string
  type: string
  title: string
  current_version: number
  created_at: string
  /** The current version's text, note and review. */
  version: { version: number; author: string; content_text: string; note: string | null; review: { passed?: boolean; issues?: string[]; checked_by?: string } | null } | null
}

export interface DocsBundle {
  applicationId: string | null
  docs: Doc[]
  /** The person's base resume, for Compare. */
  base: string | null
  attempts: ApplicationAttempt[]
}

const TYPE_LABEL: Record<string, string> = { resume: 'Resume', cover_letter: 'Cover letter', message: 'Message', research: 'Company notes', shortlist: 'Shortlist' }

const OUTCOME: Record<AttemptOutcome, string> = {
  sent: 'The site confirmed it',
  unconfirmed: 'Not confirmed. Check it on the site',
  not_sent: 'Not sent',
  marked: 'You marked it sent',
  blocked: 'Stopped before sending',
  retracted: 'You said it was not sent',
}

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function AttemptView({ a, onNotSent, busy }: { a: ApplicationAttempt; onNotSent: () => void; busy?: boolean }) {
  const fields = Object.entries(a.valuesSent ?? {})
  const counts = a.attemptOutcome === 'sent' || a.attemptOutcome === 'unconfirmed' || a.attemptOutcome === 'marked'
  return (
    <li className="space-y-1 py-3">
      <p className="r-name">{a.sentBy === 'cello' ? 'Cello sent it from your browser' : 'You sent it'}, {when(a.submittedAt)}</p>
      <p className="r-meta">{OUTCOME[a.attemptOutcome]}.{a.destination || a.finalUrl ? ` ${a.destination ?? a.finalUrl}` : ''}</p>
      <p className="r-meta">
        {[a.resumeArtifactVersion ? `Resume version ${a.resumeArtifactVersion}` : null, a.coverLetterArtifactId ? 'A cover letter' : null].filter(Boolean).join(', ') || 'No documents recorded'}
        {a.costUsd && a.costUsd > 0 ? `. $${a.costUsd.toFixed(2)}` : ''}
      </p>
      {a.confirmationText && <p className="r-body whitespace-pre-line">{a.confirmationText}</p>}
      {a.screenshotPath && <p className="r-meta">A screenshot of the confirmation was kept.</p>}
      {fields.length > 0 && (
        <details className="r-meta">
          <summary className="min-h-11 cursor-pointer leading-[44px]">Answers used ({fields.length})</summary>
          <dl className="space-y-1 pb-2">
            {fields.map(([k, v]) => (
              <div key={k}>
                <dt className="inline">{k.replace(/[._]/g, ' ')}: </dt>
                <dd className="inline">{typeof v === 'object' && v !== null ? 'Answered by you' : String(v)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {counts && <Key variant="ghost" disabled={busy} onClick={onNotSent}>I did not actually send this</Key>}
    </li>
  )
}

function ResumeDoc({ d, base }: { d: Doc; base: string | null }) {
  const [compare, setCompare] = useState(false)
  const v = d.version
  const changes = compare && v && base ? changedLines(base, v.content_text) : null
  return (
    <li className="space-y-1 py-3">
      <p className="r-name">{d.title}, version {d.current_version}</p>
      <p className="r-meta">{v?.author === 'user' ? 'You edited it' : 'Cello wrote it'}, {ago(d.created_at)}</p>
      {v?.note && <p className="r-body">Why this version: {v.note}</p>}
      {v?.review && (
        <p className="r-meta">
          {v.review.checked_by ?? 'Checked'}.{v.review.issues && v.review.issues.length > 0 ? ` To look at: ${v.review.issues.join(' ')}` : ' Nothing flagged.'}
        </p>
      )}
      {base && v && (
        <Key variant="raised" aria-expanded={compare} onClick={() => setCompare(!compare)}>{compare ? 'Hide the comparison' : 'Compare to your base resume'}</Key>
      )}
      {changes && (
        <div className="space-y-1">
          <p className="r-meta">{changes.added} lines added, {changes.removed} removed.</p>
          <ul className="r-body">
            {changes.lines.map((l, i) => (
              <li key={i} className={l.type === 'add' ? '' : 'line-through'}>
                <span className="sr-only">{l.type === 'add' ? 'Added: ' : 'Removed: '}</span>
                {l.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}

export function DocumentsPanel({ bundle, busy, note, onNotSent }: { bundle: DocsBundle; busy?: boolean; note?: string | null; onNotSent: () => void }) {
  const { docs, attempts, base } = bundle
  if (docs.length === 0 && attempts.length === 0) return null
  return (
    <section aria-labelledby="after-docs" className="r-sheet space-y-3 p-6">
      <h2 id="after-docs" className="r-title">Documents</h2>
      {docs.length > 0 && (
        <ul className="divide-y divide-[var(--r-line)]">
          {docs.map((d) =>
            d.type === 'resume' ? (
              <ResumeDoc key={d.id} d={d} base={base} />
            ) : (
              <li key={d.id} className="py-3">
                <p className="r-name">{d.title}</p>
                <p className="r-meta">{TYPE_LABEL[readType(d.type) ?? d.type] ?? d.type}, {ago(d.created_at)}</p>
                {d.version?.content_text && (
                  <details className="r-meta">
                    <summary className="min-h-11 cursor-pointer leading-[44px]">Read it</summary>
                    <p className="r-body whitespace-pre-line">{d.version.content_text}</p>
                  </details>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      {attempts.length > 0 && (
        <details className="r-dg">
          <summary>
            <span>What was sent</span>
            <span className="r-dg-count">{attempts.length}</span>
          </summary>
          <ul className="divide-y divide-[var(--r-line)]">{attempts.map((a) => <AttemptView key={a.id} a={a} busy={busy} onNotSent={onNotSent} />)}</ul>
        </details>
      )}
      {note && <p className="r-meta" role="status">{note}</p>}
    </section>
  )
}

async function loadDocs(jobId: string): Promise<DocsBundle> {
  // artifacts and artifact_versions are newer than the generated types
  const db = createClient() as unknown as SupabaseClient
  const [{ data: arts }, { data: app }, { data: baseArt }] = await Promise.all([
    db.from('artifacts').select('id, type, title, current_version, created_at').eq('job_id', jobId).order('created_at', { ascending: false }).limit(20),
    db.from('applications').select('id').eq('job_id', jobId).maybeSingle(),
    db.from('artifacts').select('id, current_version').eq('type', 'resume').is('job_id', null).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  const list = (arts ?? []) as Omit<Doc, 'version'>[]
  const ids = list.map((d) => d.id)
  const { data: vs } = ids.length
    ? await db.from('artifact_versions').select('artifact_id, version, author, content_text, note, review').in('artifact_id', ids).order('version', { ascending: false })
    : { data: [] as unknown[] }
  const newest = new Map<string, NonNullable<Doc['version']>>()
  for (const v of (vs ?? []) as (NonNullable<Doc['version']> & { artifact_id: string })[]) if (!newest.has(v.artifact_id)) newest.set(v.artifact_id, v)
  const b = baseArt as { id: string; current_version: number } | null
  const { data: baseVersion } = b ? await db.from('artifact_versions').select('content_text').eq('artifact_id', b.id).eq('version', b.current_version).maybeSingle() : { data: null }
  const applicationId = (app as { id: string } | null)?.id ?? null
  let attempts: ApplicationAttempt[] = []
  if (applicationId) {
    const res = await fetch(`/api/applications/attempts?applicationId=${applicationId}`)
    if (res.ok) attempts = ((await res.json()) as { attempts?: ApplicationAttempt[] }).attempts ?? []
  }
  return {
    applicationId,
    docs: list.map((d) => ({ ...d, version: newest.get(d.id) ?? null })),
    base: (baseVersion as { content_text: string } | null)?.content_text ?? null,
    attempts,
  }
}

export function DocumentsGroup({ jobId }: { jobId: string }) {
  const [bundle, setBundle] = useState<DocsBundle | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const load = useCallback(() => loadDocs(jobId).then(setBundle).catch(() => setBundle(null)), [jobId])
  useEffect(() => {
    void load()
  }, [load])

  async function notSent() {
    if (!bundle?.applicationId) return
    setBusy(true)
    setNote(null)
    try {
      await act(bundle.applicationId, 'retract')
      setNote('Taken back. Nothing was sent as far as Cello knows.')
      await load()
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not do that. Nothing changed.')
    } finally {
      setBusy(false)
    }
  }
  return bundle ? <DocumentsPanel bundle={bundle} busy={busy} note={note} onNotSent={notSent} /> : null
}
