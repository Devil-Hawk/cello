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
import { composeSystemPrompt, loadModeDoc } from '../prompts'

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
    company_id: string | null
    companies?: { name: string | null } | { name: string | null }[] | null
  } | null
}

function coName(app: AppRow): string {
  const c = app.jobs?.companies
  if (Array.isArray(c)) return c[0]?.name ?? ''
  return c?.name ?? ''
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

export const follow_upper: AgentFn = async (ctx) => {
  const input = FollowUpperInput.parse(ctx.input ?? {})

  // 1) Resolve candidate applications.
  let query = ctx.admin
    .from('applications')
    .select('id, stage, applied_at, updated_at, created_at, job_id, jobs(title, company_id, companies(name))')
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
    const company = coName(app) || 'this company'
    const contactId = await pickContactId(ctx.admin, ctx.userId, app.jobs?.company_id)

    const { error } = await ctx.admin.from('follow_ups').insert({
      application_id: app.id,
      contact_id: contactId,
      due_date: dueTomorrow,
      note: `Follow up on ${company} (${app.stage}) — silent for ${days} days.`,
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

  const deterministic =
    `Queued ${created.length} follow-up${created.length === 1 ? '' : 's'} (due tomorrow) for ` +
    `${created.map((c) => `${c.company} (${c.days}d silent)`).join(', ')}.`

  let message = deterministic
  let tokensUsed = 0
  try {
    const res = await ctx.llm({
      // _shared.md + _voice.md + prompts/follow_upper.md (the house-style
      // mode document — see docs/PROMPT-GENERATOR.md) is identical for every
      // user's every run — the cheapest possible cache prefix to mark.
      system: composeSystemPrompt({ mode: loadModeDoc('follow_upper') }),
      prompt: `Follow-ups queued (all due tomorrow):\n${created
        .map((c) => `- ${c.company}: silent for ${c.days} days`)
        .join('\n')}`,
      maxTokens: 220,
      temperature: 0.5,
      cachePrefix: true,
    })
    if (res.content.trim()) message = res.content.trim()
    tokensUsed = res.tokensUsed
  } catch (err) {
    if (!(err instanceof MissingKeyError)) {
      console.error('[harness] follow_upper: summary generation failed, using deterministic', err)
    }
  }

  return { output: { message, suggestedContacts: [...new Set(suggestedContacts)] }, tokensUsed }
}
