// Agent: follow_upper — find applications that have gone quiet and queue
// follow-ups from the user's OWN graph.
//
// Default behavior: scan the user's active applications (applied/screen/interview)
// that have had no activity for >10 days, and for each one with no open follow-up
// already, insert a follow_ups row due tomorrow — linked to a contact at that
// company when the user has one (contacts table = the user's own graph; no
// third-party scraping). Produces a plain-language summary via ctx.llm (metered),
// falling back to a deterministic summary when no LLM key is configured.
//
// If input.applicationId is given, the scan is scoped to that one application.
// Output satisfies FollowUpperOutput ({ message, suggestedContacts }).

import type { AgentFn, AdminClient } from '../types'
import { FollowUpperInput } from '../schemas'
import { MissingKeyError } from '../llm'
import { composeSystemPrompt, loadModeDoc, promptRef } from '../prompts'
import { unbackedTokens } from '@/lib/dossier/backing'
import { viewerRoles, type ViewerRole } from '../../jobs/person-jobs'

const STUCK_DAYS = 10
const ACTIVE_STAGES = ['applied', 'screen', 'interview']
const MAX_APPS = 50

interface AppRow {
  id: string
  stage: string
  applied_at: string | null
  updated_at: string | null
  created_at: string | null
  job_id: string | null
  jobs?: {
    title: string | null
    employer?: { name: string | null } | null
  } | null
}

// The company is the person's own (their role row), else the directory's: never the one that stored a shared role first.
function coName(app: AppRow, viewer: ViewerRole | undefined): string {
  return viewer?.viewer_company_name ?? app.jobs?.employer?.name ?? ''
}

function lastTouchMs(app: AppRow, lastActivity: number | undefined): number {
  const candidates = [app.updated_at, app.applied_at, app.created_at]
    .map((d) => (d ? Date.parse(d) : NaN))
    .filter((n) => Number.isFinite(n)) as number[]
  const base = candidates.length > 0 ? Math.max(...candidates) : 0
  return lastActivity ? Math.max(base, lastActivity) : base
}

async function pickContactId(
  admin: AdminClient,
  userId: string,
  companyId: string | null | undefined
): Promise<string | null> {
  if (!companyId) return null
  const { data } = await admin
    .from('contacts')
    .select('id')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .limit(1)
  return ((data as { id: string }[] | null) ?? [])[0]?.id ?? null
}

const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|dozen|couple|several|week|weeks|month|months|fortnight)\b/i
const SENTENCE_STARTERS = new Set(['queued', 'follow', 'followup', 'followups', 'the', 'your', 'it', 'they', 'all', 'both', 'this', 'that', 'these', 'those', 'there', 'each', 'one', 'a', 'an', 'no'])
const APPROXIMATION = /\b(about|around|roughly|approximately|nearly|almost|over|more than|under|some)\b/i

/** The deterministic sentence for a list, used when the model's line cannot be checked against it. */
export function deterministicLine(items: { company: string; days: number }[]): string {
  return (
    `Queued ${items.length} follow-up${items.length === 1 ? '' : 's'} (due tomorrow) for ` +
    `${items.map((c) => `${c.company} (${c.days}d silent)`).join(', ')}.`
  )
}

/**
 * Is a model's status line only restating the list it was given? Every number in
 * it must be a day count from the list (or the count of entries), every name a
 * company from the list, and it may not round, approximate or turn days into
 * weeks. A line that fails is replaced by the deterministic sentence.
 */
export function lineMatchesInput(line: string, items: { company: string; days: number }[]): boolean {
  const text = line.trim()
  if (!text || /[\u2013\u2014]/.test(text)) return false
  if (NUMBER_WORDS.test(text) || APPROXIMATION.test(text)) return false
  // A status line says something about the list: a company on it, or how many.
  const lower = text.toLowerCase()
  if (!items.some((c) => lower.includes(c.company.toLowerCase())) && !new RegExp(`\\b${items.length}\\b`).test(text)) return false
  const support = [`${items.length}`, ...items.map((c) => `${c.company} ${c.days}`)].join('\n')
  if (unbackedTokens(text, support).length > 0) return false
  // The first word of a sentence is capitalised by grammar, so the name check
  // skips it; a made-up company there must still be caught.
  const known = items.map((c) => c.company.toLowerCase()).join(' ')
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const first = sentence.match(/^[A-Za-z0-9'&-]+/)?.[0]
    if (first && /^[A-Z]/.test(first) && !SENTENCE_STARTERS.has(first.toLowerCase()) && !known.includes(first.toLowerCase())) return false
  }
  return true
}

export const follow_upper: AgentFn = async (ctx) => {
  const input = FollowUpperInput.parse(ctx.input ?? {})

  // 1) Resolve candidate applications.
  let query = ctx.admin
    .from('applications')
    .select('id, stage, applied_at, updated_at, created_at, job_id, jobs(title, employer:company_directory(name))')
    .eq('user_id', ctx.userId)

  if (input.applicationId) {
    query = query.eq('id', input.applicationId)
  } else {
    query = query.in('stage', ACTIVE_STAGES).limit(MAX_APPS)
  }
  const { data: appsData } = await query
  const apps = (appsData as AppRow[] | null) ?? []
  if (apps.length === 0) {
    return { output: { message: 'No active applications to follow up on.', suggestedContacts: [] }, tokensUsed: 0 }
  }

  const appIds = apps.map((a) => a.id)
  const viewer = await viewerRoles(ctx.admin, ctx.userId, apps.flatMap((a) => (a.job_id ? [a.job_id] : [])))

  // 2) Last activity per application (activities link via application_id).
  const lastActivity = new Map<string, number>()
  const { data: activities } = await ctx.admin
    .from('activities')
    .select('application_id, occurred_at')
    .in('application_id', appIds)
  for (const a of (activities as { application_id: string; occurred_at: string | null }[] | null) ?? []) {
    const t = a.occurred_at ? Date.parse(a.occurred_at) : NaN
    if (!Number.isFinite(t)) continue
    const prev = lastActivity.get(a.application_id) ?? 0
    if (t > prev) lastActivity.set(a.application_id, t)
  }

  // 3) Skip applications that already have an open (incomplete) follow-up.
  const hasOpenFollowUp = new Set<string>()
  const { data: openFus } = await ctx.admin
    .from('follow_ups')
    .select('application_id')
    .in('application_id', appIds)
    .eq('is_completed', false)
  for (const f of (openFus as { application_id: string | null }[] | null) ?? []) {
    if (f.application_id) hasOpenFollowUp.add(f.application_id)
  }

  // 4) Determine stuck applications and queue follow-ups.
  const cutoff = Date.now() - STUCK_DAYS * 24 * 60 * 60 * 1000
  const dueTomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  const created: { company: string; days: number }[] = []
  const suggestedContacts: string[] = []

  for (const app of apps) {
    if (ctx.signal.aborted) break
    if (hasOpenFollowUp.has(app.id)) continue

    const touch = lastTouchMs(app, lastActivity.get(app.id))
    if (touch === 0 || touch >= cutoff) continue // not stuck (or no reliable timestamp)

    const days = Math.floor((Date.now() - touch) / (24 * 60 * 60 * 1000))
    const role = app.job_id ? viewer.get(app.job_id) : undefined
    const company = coName(app, role) || 'this company'
    const contactId = await pickContactId(ctx.admin, ctx.userId, role?.viewer_company_id)

    const { error } = await ctx.admin.from('follow_ups').insert({
      application_id: app.id,
      contact_id: contactId,
      due_date: dueTomorrow,
      note: `Follow up on ${company} (${app.stage}), silent for ${days} days.`,
      is_completed: false,
    })
    if (error) {
      console.error(`[harness] follow_upper: failed to insert follow_up for ${app.id}`, error)
      continue
    }
    created.push({ company, days })
    if (contactId) suggestedContacts.push(contactId)
  }

  // 5) Summarize.
  if (created.length === 0) {
    return {
      output: { message: 'No applications are stuck — nothing needs a follow-up right now.', suggestedContacts: [] },
      tokensUsed: 0,
    }
  }

  const deterministic = deterministicLine(created)

  let message = deterministic
  let tokensUsed = 0
  try {
    const res = await ctx.llm({
      // _shared.md + _voice.md + prompts/follow_upper.md (the house-style
      // mode document — see docs/PROMPT-GENERATOR.md) is identical for every
      // user's every run — the cheapest possible cache prefix to mark.
      system: composeSystemPrompt({ mode: loadModeDoc('follow_upper') }),
      promptRef: promptRef('follow_upper'),
      prompt: `Follow-ups queued (all due tomorrow):\n${created
        .map((c) => `- ${c.company}: silent for ${c.days} days`)
        .join('\n')}`,
      maxTokens: 220,
      temperature: 0.5,
      cachePrefix: true,
    })
    // The model's line is kept only when it restates the list exactly.
    if (lineMatchesInput(res.content, created)) message = res.content.trim()
    tokensUsed = res.tokensUsed
  } catch (err) {
    if (!(err instanceof MissingKeyError)) {
      console.error('[harness] follow_upper: summary generation failed, using deterministic', err)
    }
  }

  return { output: { message, suggestedContacts: [...new Set(suggestedContacts)] }, tokensUsed }
}
