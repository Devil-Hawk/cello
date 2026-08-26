// Pure daily-digest composer.
//
// composeDigest(admin, userId) assembles a digest ENTIRELY from data Cello has
// already stored — no external fetch, no LLM. It is framework-free (takes an
// injected Supabase client) so it runs in BOTH the request context
// (app/api/digest) and the cron/harness context (app/api/harness/cron).
//
// Because the admin (service-role) client bypasses RLS, EVERY query here filters
// explicitly by user ownership (user_id, or company_id restricted to the user's
// own companies).

import type { SupabaseClient } from '@supabase/supabase-js'
import { ownedJobsQuery } from '@/lib/harness/agents/matcher'
import { STAGE_META, type PipelineStage } from '@/lib/format'
import {
  utcDateKey,
  type ComposedDigest,
  type DigestTopJob,
  type DigestStaleApp,
  type DigestPrepReady,
  type DigestFollowUpDue,
} from './types'

const TOP_JOBS_LIMIT = 5
const STALE_DAYS = 7
const STALE_STAGES: PipelineStage[] = ['applied', 'screen', 'interview']
const PREP_STAGES: PipelineStage[] = ['screen', 'interview']
const DAY_MS = 24 * 60 * 60 * 1000

interface CompanyRow {
  id: string
  name: string | null
}

interface JobRow {
  id: string
  title: string
  url: string | null
  match_score: number | null
  is_new: boolean | null
  company_id: string
  discovered_at: string | null
}

interface AppRow {
  id: string
  job_id: string
  stage: string
  updated_at: string
  applied_at: string | null
}

interface FollowUpRow {
  id: string
  note: string
  due_date: string
  is_completed: boolean
}

function daysBetween(fromIso: string, now: number): number {
  const then = new Date(fromIso).getTime()
  if (Number.isNaN(then)) return 0
  return Math.max(0, Math.floor((now - then) / DAY_MS))
}

function stageLabel(stage: string): string {
  return STAGE_META[stage as PipelineStage]?.label ?? stage
}

/**
 * Compose today's digest for a user from stored tables only. Never throws on
 * missing data — returns an `empty: true` payload when there is nothing to say.
 */
export async function composeDigest(
  admin: SupabaseClient,
  userId: string
): Promise<ComposedDigest> {
  const now = Date.now()
  const date = utcDateKey()

  // 1) The user's own companies (for name lookup + job scoping).
  const { data: companyData } = await admin
    .from('companies')
    .select('id, name')
    .eq('user_id', userId)
  const companies = (companyData as CompanyRow[] | null) ?? []
  const companyName = new Map<string, string | null>(companies.map((c) => [c.id, c.name]))
  const companyIds = companies.map((c) => c.id)

  // 2) Top fresh/high-match jobs across the user's tracked companies.
  let topJobs: DigestTopJob[] = []
  if (companyIds.length > 0) {
    // Ownership via the companies FK join (ownedJobsQuery), not an
    // .in('company_id', companyIds) array — that breaks past ~600 companies.
    const { data: jobData } = await ownedJobsQuery(
      admin,
      userId,
      'id, title, url, match_score, is_new, company_id, discovered_at, companies!inner(user_id)'
    )
      .order('match_score', { ascending: false, nullsFirst: false })
      .order('discovered_at', { ascending: false })
      .limit(TOP_JOBS_LIMIT)
    const jobs = (jobData as JobRow[] | null) ?? []
    topJobs = jobs.map((j) => ({
      jobId: j.id,
      title: j.title,
      companyName: companyName.get(j.company_id) ?? null,
      matchScore: j.match_score,
      url: j.url,
    }))
  }

  // 3) The user's applications (for stale + prep cuts). Join job title.
  const { data: appData } = await admin
    .from('applications')
    .select('id, job_id, stage, updated_at, applied_at, jobs(id, title, company_id)')
    .eq('user_id', userId)
  const apps = (appData as unknown as (AppRow & {
    jobs: { id: string; title: string; company_id: string } | null
  })[] | null) ?? []

  const staleApps: DigestStaleApp[] = []
  const prepReady: DigestPrepReady[] = []
  for (const app of apps) {
    const jobTitle = app.jobs?.title ?? 'Untitled role'
    const cName = app.jobs?.company_id ? companyName.get(app.jobs.company_id) ?? null : null
    if (PREP_STAGES.includes(app.stage as PipelineStage)) {
      prepReady.push({
        jobId: app.job_id,
        jobTitle,
        companyName: cName,
        stage: app.stage,
      })
    }
    if (STALE_STAGES.includes(app.stage as PipelineStage)) {
      const daysStale = daysBetween(app.updated_at, now)
      if (daysStale >= STALE_DAYS) {
        staleApps.push({
          applicationId: app.id,
          jobTitle,
          companyName: cName,
          stage: app.stage,
          daysStale,
        })
      }
    }
  }
  staleApps.sort((a, b) => b.daysStale - a.daysStale)

  // 4) Follow-ups due or overdue (not completed).
  const { data: fuData } = await admin
    .from('follow_ups')
    .select('id, note, due_date, is_completed, applications!inner(user_id)')
    .eq('applications.user_id', userId)
    .eq('is_completed', false)
    .order('due_date', { ascending: true })
  const followUps = (fuData as unknown as FollowUpRow[] | null) ?? []
  const followUpsDue: DigestFollowUpDue[] = followUps
    .filter((f) => new Date(f.due_date).getTime() <= now + DAY_MS) // due today/overdue
    .map((f) => ({
      id: f.id,
      note: f.note,
      dueDate: f.due_date,
      overdue: new Date(f.due_date).getTime() < now,
    }))

  const empty =
    topJobs.length === 0 &&
    prepReady.length === 0 &&
    staleApps.length === 0 &&
    followUpsDue.length === 0

  const subject = empty
    ? 'Your Cello digest — all quiet today'
    : `Your Cello digest — ${topJobs.length} top match${topJobs.length === 1 ? '' : 'es'}, ${followUpsDue.length} follow-up${followUpsDue.length === 1 ? '' : 's'} due`

  const text = renderText({ topJobs, prepReady, staleApps, followUpsDue, empty })
  const html = renderHtml({ topJobs, prepReady, staleApps, followUpsDue, empty })

  return { date, subject, text, html, topJobs, prepReady, staleApps, followUpsDue, empty }
}

interface RenderParts {
  topJobs: DigestTopJob[]
  prepReady: DigestPrepReady[]
  staleApps: DigestStaleApp[]
  followUpsDue: DigestFollowUpDue[]
  empty: boolean
}

function renderText(p: RenderParts): string {
  if (p.empty) {
    return 'Nothing needs your attention today. Enjoy the calm — Cello is still watching your tracked companies.'
  }
  const lines: string[] = ['Your Cello daily digest', '']
  if (p.topJobs.length) {
    lines.push('Top matches:')
    for (const j of p.topJobs) {
      const score = j.matchScore != null ? ` (${j.matchScore}% match)` : ''
      lines.push(`  • ${j.title}${j.companyName ? ` @ ${j.companyName}` : ''}${score}`)
    }
    lines.push('')
  }
  if (p.followUpsDue.length) {
    lines.push('Follow-ups due:')
    for (const f of p.followUpsDue) {
      lines.push(`  • ${f.overdue ? '[overdue] ' : ''}${f.note}`)
    }
    lines.push('')
  }
  if (p.prepReady.length) {
    lines.push('Interviews to prep for:')
    for (const k of p.prepReady) {
      lines.push(`  • ${k.jobTitle}${k.companyName ? ` @ ${k.companyName}` : ''} (${stageLabel(k.stage)})`)
    }
    lines.push('')
  }
  if (p.staleApps.length) {
    lines.push('Going quiet (no update in a while):')
    for (const s of p.staleApps) {
      lines.push(`  • ${s.jobTitle}${s.companyName ? ` @ ${s.companyName}` : ''} — ${s.daysStale}d in ${stageLabel(s.stage)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderHtml(p: RenderParts): string {
  if (p.empty) {
    return '<div style="font-family:system-ui,sans-serif;color:#111"><h2>Your Cello daily digest</h2><p>Nothing needs your attention today. Enjoy the calm — Cello is still watching your tracked companies.</p></div>'
  }
  const sections: string[] = []
  if (p.topJobs.length) {
    const items = p.topJobs
      .map((j) => {
        const score = j.matchScore != null ? ` <span style="color:#059669">(${j.matchScore}% match)</span>` : ''
        const label = `${esc(j.title)}${j.companyName ? ` @ ${esc(j.companyName)}` : ''}${score}`
        return `<li>${j.url ? `<a href="${esc(j.url)}">${label}</a>` : label}</li>`
      })
      .join('')
    sections.push(`<h3>Top matches</h3><ul>${items}</ul>`)
  }
  if (p.followUpsDue.length) {
    const items = p.followUpsDue
      .map((f) => `<li>${f.overdue ? '<strong style="color:#dc2626">Overdue:</strong> ' : ''}${esc(f.note)}</li>`)
      .join('')
    sections.push(`<h3>Follow-ups due</h3><ul>${items}</ul>`)
  }
  if (p.prepReady.length) {
    const items = p.prepReady
      .map((k) => `<li>${esc(k.jobTitle)}${k.companyName ? ` @ ${esc(k.companyName)}` : ''} <em>(${esc(stageLabel(k.stage))})</em></li>`)
      .join('')
    sections.push(`<h3>Interviews to prep for</h3><ul>${items}</ul>`)
  }
  if (p.staleApps.length) {
    const items = p.staleApps
      .map((s) => `<li>${esc(s.jobTitle)}${s.companyName ? ` @ ${esc(s.companyName)}` : ''} — ${s.daysStale}d in ${esc(stageLabel(s.stage))}</li>`)
      .join('')
    sections.push(`<h3>Going quiet</h3><ul>${items}</ul>`)
  }
  return `<div style="font-family:system-ui,sans-serif;color:#111;max-width:560px"><h2>Your Cello daily digest</h2>${sections.join('')}</div>`
}
