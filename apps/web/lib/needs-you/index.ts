// Needs you: the one list of what waits on the person. Today, the bell, the phone badge, the tab
// title and the email all read it, so they never disagree. One row per target, never two; every
// application that is ready to send is one grouped row that counts each application in the badge.
//
// The pipeline's rows come from applications (state and needs_reason), the search's from nextStep,
// mail's from messages found in email; a lane adds its own through `kinds/<lane>.ts`.

import type { SupabaseClient } from '@supabase/supabase-js'
import { listFound } from '@/lib/applications/found'
import { nextStep } from '@/lib/pipeline/next-step'
import { readPipelineSettings } from '@/lib/pipeline/settings'
import { statusSentence } from '@/lib/pipeline/states'
import type { ApplicationState, NeedsReason } from '@/lib/pipeline/types'
import { kinds as networkKinds } from './kinds/network'
import { NEEDS_YOU_GROUPS, type NeedsYouContext, type NeedsYouGroup, type NeedsYouKind, type NeedsYouKindSource, type NeedsYouList, type NeedsYouRow } from './types'

export * from './types'

/** Every lane's source. A lane adds its file and one line here. */
const SOURCES: NeedsYouKindSource[] = [...networkKinds]

const GROUP_OF_REASON: Record<NeedsReason, NeedsYouGroup> = {
  approve_resume: 'approval',
  duplicate: 'approval',
  your_turn: 'site',
  check_sent: 'site',
  answer: 'question',
  reconnect: 'setup',
  budget: 'setup',
  wait_computer: 'setup',
}

const BUTTON_OF_REASON: Record<NeedsReason, string> = {
  approve_resume: 'Approve resume',
  duplicate: 'Already applied?',
  your_turn: 'Open on site',
  check_sent: 'Did you send it?',
  answer: 'Answer',
  reconnect: 'Reconnect Gmail',
  budget: 'See the cap',
  wait_computer: 'See why',
}

interface AppRow {
  id: string
  state: ApplicationState | null
  step: string | null
  needs_reason: NeedsReason | null
  needs_detail: Record<string, unknown> | null
  stage: string
  closed_reason: string | null
  applied_at: string | null
  interview_at: string | null
  last_event_at: string | null
  found_state: string | null
  jobs: { title: string; companies: { id: string; name: string; logo_url: string | null } | null } | null
}

const DAY = 86_400_000

function row(a: AppRow, kind: NeedsYouKind, group: NeedsYouGroup, sentence: string, button: { label: string; command: string }, over: Partial<NeedsYouRow> = {}): NeedsYouRow {
  return {
    id: `${kind}:${a.id}`,
    kind,
    group,
    target: { kind: 'application', id: a.id },
    companyId: a.jobs?.companies?.id ?? null,
    companyName: a.jobs?.companies?.name ?? null,
    logoUrl: a.jobs?.companies?.logo_url ?? null,
    roleTitle: a.jobs?.title ?? null,
    sentence,
    dueAt: null,
    button: { ...button, args: { applicationId: a.id } },
    count: 1,
    members: [],
    ...over,
  }
}

async function pipelineRows(ctx: NeedsYouContext): Promise<NeedsYouRow[]> {
  const { client, userId, now } = ctx
  const { data: profile } = await client.from('profiles').select('preferences').eq('id', userId).maybeSingle()
  const settings = readPipelineSettings((profile as { preferences?: unknown } | null)?.preferences)

  const { data } = await client
    .from('applications')
    .select('id, state, step, needs_reason, needs_detail, stage, closed_reason, applied_at, interview_at, last_event_at, found_state, jobs(title, companies(id, name, logo_url))')
    .eq('user_id', userId)
    .order('last_event_at', { ascending: false, nullsFirst: false })
    .limit(500)
  const apps = (data ?? []) as unknown as AppRow[]

  // the newest verified-or-not mail per application, for the search's next step
  const { data: msgs } = await client
    .from('messages')
    .select('application_id, sent_at, kind, trust')
    .eq('user_id', userId)
    .not('application_id', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(1000)
  const lastIn = new Map<string, { at: string; kind: string; trust: string }>()
  for (const m of (msgs ?? []) as { application_id: string; sent_at: string; kind: string; trust: string }[]) {
    if (!lastIn.has(m.application_id)) lastIn.set(m.application_id, { at: m.sent_at, kind: m.kind, trust: m.trust })
  }

  const out: NeedsYouRow[] = []
  const ready: NeedsYouRow[] = []
  for (const a of apps) {
    if (a.found_state === 'to_confirm') continue // listed by the found source, once
    const company = a.jobs?.companies?.name ?? 'the company'
    if (a.state === 'needs_you' && a.needs_reason) {
      const sentence = statusSentence({ state: a.state, step: a.step, needsReason: a.needs_reason, needsDetail: a.needs_detail }, company)
      out.push(row(a, a.needs_reason, GROUP_OF_REASON[a.needs_reason], sentence, { label: BUTTON_OF_REASON[a.needs_reason], command: `/applications/${a.id}` }))
      continue
    }
    if (a.state === 'ready') {
      ready.push(row(a, 'ready', 'ready', `${a.jobs?.title ?? 'This role'} at ${company} is ready to send.`, { label: 'Open', command: `/applications/${a.id}/apply` }))
      continue
    }
    const inbound = lastIn.get(a.id) ?? null
    const next = nextStep({
      stage: a.stage,
      state: a.state,
      closedReason: a.closed_reason,
      appliedAt: a.applied_at,
      interviewAt: a.interview_at,
      lastInbound: inbound,
      // ponytail: "answered" is read from the stage the person set after the mail; message.sent events refine it
      answeredAfterInbound: Boolean(inbound && a.last_event_at && new Date(a.last_event_at) > new Date(inbound.at) && a.state === 'sent'),
      followUpDays: settings.followUps.on ? settings.followUps.afterDays : null,
      now,
    })
    if (next) {
      const group: NeedsYouGroup = next.kind === 'reply' ? 'reply' : next.kind === 'offer_due' ? 'due' : 'follow_up'
      out.push(row(a, next.kind, group, `${company}: ${next.sentence}`, { label: next.kind === 'reply' ? 'Open' : 'See it', command: `/applications/${a.id}` }, { dueAt: next.dueAt }))
    }
  }

  // one grouped row for everything ready to send: each application counts once in the badge
  if (ready.length === 1) out.push(ready[0])
  else if (ready.length > 1) {
    out.push({
      id: 'ready:all',
      kind: 'ready',
      group: 'ready',
      target: { kind: 'application', id: ready[0].target.id },
      companyId: null,
      companyName: null,
      logoUrl: null,
      roleTitle: null,
      sentence: `${ready.length} applications are ready to send.`,
      dueAt: null,
      button: { label: 'Open the first', command: ready[0].button.command },
      count: ready.length,
      members: ready,
    })
  }
  return out
}

async function foundRows(ctx: NeedsYouContext): Promise<NeedsYouRow[]> {
  const found = await listFound(ctx.client, ctx.userId)
  return found.map((f) => ({
    id: `confirm_found:${f.applicationId ?? f.messageId}`,
    kind: 'confirm_found' as const,
    group: 'stage' as const,
    target: { kind: 'application' as const, id: (f.applicationId ?? f.messageId) as string },
    companyId: null,
    companyName: f.company || null,
    logoUrl: null,
    roleTitle: f.title,
    sentence: `${f.company || 'A company'} confirmed an application${f.title ? ` for ${f.title}` : ''} in your email. Is it yours?`,
    dueAt: null,
    button: { label: 'Confirm', command: 'applications.confirm_found', args: f.applicationId ? { applicationId: f.applicationId } : { messageId: f.messageId } },
    count: 1,
    members: [],
  }))
}

/** Due within 48 hours first, then the groups in their order, then the newest. One row per target and kind. */
export function order(rows: readonly NeedsYouRow[], now: Date): NeedsYouRow[] {
  const seen = new Set<string>()
  const unique = rows.filter((r) => {
    const key = `${r.target.kind}:${r.target.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const soon = (r: NeedsYouRow) => r.dueAt !== null && new Date(r.dueAt).getTime() - now.getTime() <= 2 * DAY
  return unique
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const sa = soon(a.r)
      const sb = soon(b.r)
      if (sa !== sb) return sa ? -1 : 1
      if (sa && sb) return new Date(a.r.dueAt as string).getTime() - new Date(b.r.dueAt as string).getTime()
      return NEEDS_YOU_GROUPS.indexOf(a.r.group) - NEEDS_YOU_GROUPS.indexOf(b.r.group) || a.i - b.i
    })
    .map((x) => x.r)
}

export async function loadNeedsYou(client: SupabaseClient, userId: string, now: Date = new Date()): Promise<NeedsYouList> {
  const ctx: NeedsYouContext = { client, userId, now }
  const lists = await Promise.all([pipelineRows(ctx), foundRows(ctx), ...SOURCES.map((s) => s.load(ctx))])
  const rows = order(lists.flat(), now)
  return { rows, count: rows.reduce((n, r) => n + r.count, 0) }
}
