'use client'

// Structured renderers for copilot tool observations.
//
// Tool results used to render as `JSON.stringify(value, null, 2)` inside a
// <pre>, so a jobs list read as a wall of escaped JSON truncated mid-string
// ({"count":15,"jobs":[{"jobId":"36504150-…). The model's own summary was the
// only legible part of the turn. These renderers turn the shapes the copilot
// tools actually return into something scannable, and fall back to formatted
// JSON only for shapes nothing here recognises.

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { ResumeDiff } from '@/components/resume/resume-diff'

interface JobRow {
  jobId?: string
  title?: string
  company?: string
  matchScore?: number | null
  location?: string | null
  fresh?: boolean
  postedAt?: string | null
}

function scoreTone(score: number | null | undefined): string {
  if (typeof score !== 'number') return 'text-muted-foreground'
  if (score >= 80) return 'text-emerald-600 dark:text-emerald-400'
  if (score >= 60) return 'text-accent-deep'
  if (score >= 40) return 'text-amber-600 dark:text-amber-400'
  return 'text-muted-foreground'
}

function JobsTable({ jobs, count }: { jobs: JobRow[]; count?: number }) {
  const shown = jobs.slice(0, 12)
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        {count ?? jobs.length} job{(count ?? jobs.length) === 1 ? '' : 's'}
        {jobs.length > shown.length && ` · showing ${shown.length}`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <tbody>
            {shown.map((j, i) => (
              <tr key={j.jobId ?? i} className="border-b border-border/50 last:border-0">
                <td className="py-1 pr-2 font-medium text-foreground">{j.title ?? '—'}</td>
                <td className="py-1 pr-2 text-muted-foreground">{j.company ?? '—'}</td>
                <td className="py-1 pr-2 text-muted-foreground">{j.location ?? '—'}</td>
                <td className={cn('py-1 text-right tabular-nums', scoreTone(j.matchScore))}>
                  {typeof j.matchScore === 'number' ? `${j.matchScore}%` : 'unscored'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
        <span
          className="block h-full rounded-full bg-accent-deep transition-all"
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </span>
      <span className={cn('w-9 text-right text-[11px] tabular-nums', scoreTone(value))}>{value}</span>
    </div>
  )
}

function Bullets({ title, items, tone }: { title: string; items: string[]; tone?: 'good' | 'bad' }) {
  if (!items.length) return null
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="space-y-0.5">
        {items.slice(0, 6).map((s, i) => (
          <li
            key={i}
            className={cn(
              'flex gap-1.5 text-[11px] leading-relaxed',
              tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
              tone === 'bad' && 'text-amber-700 dark:text-amber-400',
              !tone && 'text-foreground'
            )}
          >
            <span aria-hidden="true">·</span>
            <span>{s}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Presentation-only text cleanup for free-text note/reason strings a tool
 *  hands back — the internal machinery is what stores a "dossier" (that's
 *  the DB table name, company_dossiers), but the person asking just wants to
 *  know what Cello found about the company. Never touches the underlying
 *  data, only how a string renders. */
function humanize(text: string): string {
  return text.replace(/\bdossiers?\b/gi, (m) => (m[0] === m[0].toUpperCase() ? 'Company research' : 'company research'))
}

function SponsorBadge({ value }: { value: string }) {
  const tone = /^(likely|yes)/i.test(value)
    ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
    : /^(unlikely|no)/i.test(value)
    ? 'border-amber-500/40 text-amber-700 dark:text-amber-400'
    : 'border-border text-muted-foreground'
  return (
    <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium', tone)}>
      Visa sponsorship: {value}
    </span>
  )
}

/** get_dossier / research_company: what Cello found about a company, in
 *  plain terms — replaces a raw JSON dump of dossierId/exists/sponsorsVisa
 *  keys with a scannable summary, and runs any free-text note/reason through
 *  humanize() so "dossier" never reaches the person asking about funding or
 *  visa sponsorship. */
function CompanyResearch({ o }: { o: Record<string, unknown> }) {
  const company = typeof o.company === 'string' ? o.company : undefined
  const note = typeof o.note === 'string' ? o.note : typeof o.reason === 'string' ? o.reason : undefined

  if (o.exists === false) {
    return (
      <div className="space-y-1">
        {company && <p className="text-[11px] font-medium text-foreground">{company}</p>}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {note ? humanize(note) : "Nothing researched about this company yet."}
        </p>
      </div>
    )
  }

  const summary = typeof o.summary === 'string' ? o.summary : undefined
  const partial = o.partial === true
  const sourceCount = typeof o.sourceCount === 'number' ? o.sourceCount : undefined

  return (
    <div className="space-y-2">
      {company && <p className="text-[11px] font-medium text-foreground">{company}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {typeof o.sponsorsVisa === 'string' && o.sponsorsVisa && <SponsorBadge value={o.sponsorsVisa} />}
        {partial && (
          <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
            Partial — no AI summary yet
          </span>
        )}
        {typeof sourceCount === 'number' && (
          <span className="text-[10px] text-muted-foreground">
            {sourceCount} source{sourceCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {summary && <p className="text-[11px] leading-relaxed text-foreground">{summary}</p>}
      {note && <p className="text-[11px] leading-relaxed text-muted-foreground">{humanize(note)}</p>}
    </div>
  )
}

/** research_companies (batch) result: requested/researched/failed counts plus
 *  each company's own status/reason — the batch sibling of CompanyResearch
 *  above, but for the `results[]` array doResearchCompanies returns instead
 *  of a single top-level shape. Without this branch a clean batch (where the
 *  top-level `note` is undefined because nothing was skipped) fell all the
 *  way through to the final `<pre>{JSON.stringify(...)}</pre>` fallback,
 *  which rendered each result's raw `reason` string ("Dossier saved.") and
 *  the `dossierId` field name verbatim. Every free-text reason still goes
 *  through humanize() so "dossier" never reaches the person asking. */
function ResearchBatchSummary({ o }: { o: Record<string, unknown> }) {
  const results = Array.isArray(o.results) ? (o.results as Record<string, unknown>[]) : []
  const researched = typeof o.researched === 'number' ? o.researched : results.filter((r) => r.status === 'researched').length
  const failed = typeof o.failed === 'number' ? o.failed : results.length - researched
  const requested = typeof o.requested === 'number' ? o.requested : results.length
  const note = typeof o.note === 'string' ? o.note : undefined

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Researched <span className="font-medium text-foreground">{researched}</span> of {requested} compan
        {requested === 1 ? 'y' : 'ies'}
        {failed > 0 && ` · ${failed} failed`}
      </p>
      {note && <p className="text-[11px] leading-relaxed text-foreground">{humanize(note)}</p>}
      {results.length > 0 && (
        <ul className="space-y-1">
          {results.slice(0, 12).map((r, i) => {
            const company =
              typeof r.company === 'string' && r.company
                ? r.company
                : typeof r.companyId === 'string'
                ? r.companyId
                : `Company ${i + 1}`
            const ok = r.status === 'researched'
            const reason = typeof r.reason === 'string' ? humanize(r.reason) : undefined
            return (
              <li key={i} className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      'text-[11px] font-medium',
                      ok ? 'text-foreground' : 'text-rose-600 dark:text-rose-400'
                    )}
                  >
                    {company}
                  </span>
                  {typeof r.sponsorsVisa === 'string' && r.sponsorsVisa && <SponsorBadge value={r.sponsorsVisa} />}
                  {r.partial === true && (
                    <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                      Partial — no AI summary yet
                    </span>
                  )}
                </div>
                {reason && <p className="text-[11px] leading-relaxed text-muted-foreground">{reason}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** source_jobs result: what the sourcing pass found + inserted, plus the same
 *  JobsTable list_jobs uses so the newly-discovered postings are scannable
 *  right in the thread instead of "go check the Jobs page". */
function SourceSummary({ o }: { o: Record<string, unknown> }) {
  const found = typeof o.found === 'number' ? o.found : 0
  const inserted = typeof o.inserted === 'number' ? o.inserted : 0
  const jobs = Array.isArray(o.jobs) ? (o.jobs as JobRow[]) : []
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        {found} found · <span className="font-medium text-foreground">{inserted} new</span>
        {typeof o.query === 'string' && <> · query: {o.query}</>}
      </p>
      {jobs.length > 0 && <JobsTable jobs={jobs} />}
      {typeof o.note === 'string' && <p className="text-[11px] leading-relaxed text-foreground">{o.note}</p>}
    </div>
  )
}

/** score_jobs result: how many of the candidate batch got scored/failed/
 *  skipped, why (skippedReasons), and the resulting scores via JobsTable. */
function ScoreSummary({ o }: { o: Record<string, unknown> }) {
  const scored = typeof o.scored === 'number' ? o.scored : 0
  const failed = typeof o.failed === 'number' ? o.failed : 0
  const considered = typeof o.candidatesConsidered === 'number' ? o.candidatesConsidered : 0
  const jobs = Array.isArray(o.jobs) ? (o.jobs as JobRow[]) : []
  const skipped = (o.skippedReasons && typeof o.skippedReasons === 'object' ? o.skippedReasons : {}) as Record<
    string,
    number
  >
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Scored <span className="font-medium text-foreground">{scored}</span> of {considered} candidate
        {considered === 1 ? '' : 's'}
        {failed > 0 && ` · ${failed} failed`}
      </p>
      {Object.keys(skipped).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(skipped).map(([reason, n]) => (
            <span key={reason} className="rounded bg-sunken px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {reason}: {n}
            </span>
          ))}
        </div>
      )}
      {jobs.length > 0 && <JobsTable jobs={jobs} />}
      {typeof o.note === 'string' && <p className="text-[11px] leading-relaxed text-foreground">{o.note}</p>}
    </div>
  )
}

/**
 * Inline before/after preview for `optimize_resume` — fetches the user's
 * current base resume (GET /api/resume/documents?jobId=base, read-only) and
 * diffs it against the tool's rewrite preview via the resume studio's own
 * lib/resume/diff.ts + <ResumeDiff>, so this never duplicates that diff logic.
 *
 * FIDELITY NOTE: `rewritePreview` is the copilot tool's own observation field
 * (lib/harness/copilot-tools.ts doOptimizeResume), already capped to 700
 * characters there before it ever reaches this component — nothing here
 * truncates it further, but the "after" column is genuinely a preview, not
 * the full rewrite (this tool call never saves anything, so the full rewrite
 * exists only for the duration of that one server call). Labeled as such
 * below rather than presented as complete.
 */
function ResumeRewriteDiff({ preview }: { preview: string }) {
  const [before, setBefore] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    fetch('/api/resume/documents?jobId=base')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data) => {
        if (cancelled) return
        const versions = Array.isArray(data?.versions) ? data.versions : []
        const content = typeof versions[0]?.content === 'string' ? versions[0].content : ''
        setBefore(content)
        setState('ready')
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'loading') {
    return <p className="text-[11px] text-muted-foreground">Loading current resume for comparison…</p>
  }
  if (state === 'error' || !before) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Couldn't load your current resume to diff against — showing the rewrite preview only.
      </p>
    )
  }
  return (
    <div className="space-y-1">
      <ResumeDiff before={before} after={preview} beforeLabel="Current resume" afterLabel="Proposed rewrite (preview)" />
      <p className="text-[10px] text-muted-foreground">
        Preview only — capped to the first 700 characters, and nothing here is saved. Nothing changes until you save
        it from the Resume Studio.
      </p>
    </div>
  )
}

/** Render a tool observation as structured UI, falling back to pretty JSON. */
export function ObservationView({ observation }: { observation: unknown }) {
  let value: unknown = observation
  if (typeof observation === 'string') {
    try {
      value = JSON.parse(observation)
    } catch {
      return (
        <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">{observation}</p>
      )
    }
  }
  if (typeof value !== 'object' || value === null) {
    return <p className="text-[11px] text-foreground">{String(value)}</p>
  }
  const o = value as Record<string, unknown>

  if (typeof o.error === 'string') {
    return <p className="text-[11px] leading-relaxed text-rose-600 dark:text-rose-400">{o.error}</p>
  }

  // source_jobs — checked ahead of the generic o.jobs branch below so the
  // found/inserted counts render alongside the jobs table, not just the table.
  if (typeof o.found === 'number' && typeof o.inserted === 'number') {
    return <SourceSummary o={o} />
  }

  // score_jobs — same reasoning: scored/candidatesConsidered are unique to
  // this tool's shape, checked ahead of the generic o.jobs branch.
  if (typeof o.scored === 'number' && typeof o.candidatesConsidered === 'number') {
    return <ScoreSummary o={o} />
  }

  if (Array.isArray(o.jobs)) {
    return <JobsTable jobs={o.jobs as JobRow[]} count={typeof o.count === 'number' ? o.count : undefined} />
  }

  // explain_match / match details
  if (typeof o.overallScore === 'number' || typeof o.score === 'number') {
    const overall = (typeof o.overallScore === 'number' ? o.overallScore : (o.score as number)) ?? 0
    return (
      <div className="space-y-2">
        <ScoreBar label="Overall" value={overall} />
        {typeof o.skillsMatch === 'number' && <ScoreBar label="Skills" value={o.skillsMatch} />}
        {typeof o.experienceMatch === 'number' && <ScoreBar label="Experience" value={o.experienceMatch} />}
        {typeof o.locationMatch === 'number' && <ScoreBar label="Location" value={o.locationMatch} />}
        {typeof o.summary === 'string' && (
          <p className="text-[11px] leading-relaxed text-foreground">{o.summary}</p>
        )}
        <Bullets title="Strengths" items={strList(o.highlights ?? o.strengths)} tone="good" />
        <Bullets title="Gaps" items={strList(o.gaps)} tone="bad" />
      </div>
    )
  }

  // get_dossier / research_company — checked ahead of the generic o.note
  // fallback below so the "not researched yet" / partial-research cases get
  // the company name + a humanized note, not a bare raw string.
  if (typeof o.dossierId === 'string' || typeof o.exists === 'boolean') {
    return <CompanyResearch o={o} />
  }

  // research_companies (batch) — checked ahead of the generic o.note fallback
  // (that top-level note is only set when something was skipped or every
  // company failed — a clean N-for-N batch leaves it undefined) and ahead of
  // the final <pre> JSON dump, so a successful batch renders per-company
  // status instead of raw {"reason":"Dossier saved.","dossierId":"..."} JSON.
  if (Array.isArray(o.results) && (typeof o.researched === 'number' || typeof o.failed === 'number')) {
    return <ResearchBatchSummary o={o} />
  }

  // ATS optimizer
  if (typeof o.atsScore === 'number') {
    const after = (o.rescore as Record<string, unknown> | undefined)?.atsScore
    return (
      <div className="space-y-2">
        <ScoreBar label="ATS before" value={o.atsScore} />
        {typeof after === 'number' && <ScoreBar label="ATS after" value={after} />}
        <Bullets title="Matched" items={strList(o.matchedKeywords)} tone="good" />
        <Bullets title="Missing" items={strList(o.missingKeywords)} tone="bad" />
        <Bullets title="Format issues" items={strList(o.formatIssues)} />
        {typeof o.rewritePreview === 'string' && o.rewritePreview.trim() && (
          <ResumeRewriteDiff preview={o.rewritePreview} />
        )}
      </div>
    )
  }

  if (Array.isArray(o.runs)) {
    const runs = o.runs as Array<Record<string, unknown>>
    return (
      <ul className="space-y-1">
        {runs.slice(0, 10).map((r, i) => (
          <li key={String(r.id ?? i)} className="flex items-center gap-2 text-[11px]">
            <span className="font-medium text-foreground">{String(r.status ?? '—')}</span>
            <span className="truncate text-muted-foreground">{String(r.goal ?? '')}</span>
          </li>
        ))}
      </ul>
    )
  }

  if (Array.isArray(o.contacts)) {
    const contacts = o.contacts as Array<Record<string, unknown>>
    return (
      <ul className="space-y-1">
        {contacts.slice(0, 10).map((c, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-2 text-[11px]">
            <span className="font-medium text-foreground">{String(c.name ?? c.email ?? '—')}</span>
            {typeof c.title === 'string' && <span className="text-muted-foreground">{c.title}</span>}
            {typeof c.source === 'string' && (
              <span className="rounded bg-sunken px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {c.source}
              </span>
            )}
          </li>
        ))}
      </ul>
    )
  }

  if (typeof o.note === 'string') {
    return <p className="text-[11px] leading-relaxed text-foreground">{humanize(o.note)}</p>
  }

  return (
    <pre className="max-h-64 overflow-auto rounded bg-card px-2 py-1.5 text-[11px] leading-relaxed text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}
