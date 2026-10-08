// Who is due a follow-up, in code over contact_touch and messages, in the person's zone; and the drafts
// network.nudge writes for people newly due. A draft waits for the person's approval: sending is their click.

import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_RULE, nudgeFor, type NudgeRule, type PersonRule } from './nudge'
import { getPerson, type Tie } from './people'

export interface DueNudge {
  contactId: string
  name: string
  firstName: string
  email: string | null
  title: string | null
  employer: string | null
  agency: string | null
  waitingOn: 'you' | 'them'
  fact: string
  dueAt: string
  threadId: string | null
  tie: Tie | null
  /** The drafted follow-up waiting for approval, when there is one. */
  draftId: string | null
}

const CLOSED_STAGES = new Set(['rejected', 'withdrawn', 'ghosted', 'closed'])

/** The person's global rule and zone. */
export async function ruleOf(db: SupabaseClient, userId: string): Promise<{ rule: NudgeRule; zone: string }> {
  const [{ data: p }, { data: r }] = await Promise.all([
    db.from('profiles').select('preferences').eq('id', userId).maybeSingle(),
    db.from('routines').select('timezone').eq('user_id', userId).eq('command', 'roles.check').limit(1).maybeSingle(),
  ])
  const nudge = ((p as { preferences?: { network?: { nudge?: Partial<NudgeRule> } } } | null)?.preferences?.network?.nudge ?? {}) as Partial<NudgeRule>
  return { rule: { ...DEFAULT_RULE, ...nudge }, zone: (r as { timezone?: string | null } | null)?.timezone || 'UTC' }
}

/** People due a follow-up now, soonest first. One per person: the thread that has waited longest. */
export async function dueNudges(db: SupabaseClient, userId: string, now = new Date()): Promise<DueNudge[]> {
  const { rule, zone } = await ruleOf(db, userId)
  if (!rule.on) return []
  const { data: touch } = await db
    .from('contact_touch')
    .select('contact_id, name, email, title, kind, agency_name, employer_id, waiting_on')
    .eq('user_id', userId)
    .neq('waiting_on', 'none')
    .not('last_at', 'is', null)
    .order('last_at', { ascending: false })
    .limit(150)
  const people = (touch ?? []) as { contact_id: string; name: string; email: string | null; title: string | null; agency_name: string | null; employer_id: string | null }[]
  if (!people.length) return []
  const ids = people.map((p) => p.contact_id)

  const [{ data: msgs }, { data: contacts }, { data: drafts }, { data: ties }] = await Promise.all([
    db.from('messages').select('contact_id, thread_id, application_id, direction, sent_at').eq('user_id', userId).in('contact_id', ids.slice(0, 150)).order('sent_at', { ascending: false }).limit(5000),
    db.from('contacts').select('id, nudge').eq('user_id', userId).in('id', ids.slice(0, 150)),
    db.from('outreach_messages').select('id, contact_id').eq('user_id', userId).eq('kind', 'follow_up').eq('status', 'pending_review').in('contact_id', ids.slice(0, 150)),
    db.from('contact_applications').select('contact_id, application_id, applications(stage, closed_reason, state, job_id, jobs(id, title, companies(name)))').in('contact_id', ids.slice(0, 150)),
  ])
  const rows = (msgs ?? []) as { contact_id: string; thread_id: string | null; application_id: string | null; direction: 'in' | 'out'; sent_at: string }[]
  const personRule = new Map(((contacts ?? []) as { id: string; nudge: PersonRule | null }[]).map((c) => [c.id, c.nudge]))
  const draftOf = new Map(((drafts ?? []) as { id: string; contact_id: string }[]).map((d) => [d.contact_id, d.id]))
  type App = { stage: string; closed_reason: string | null; state: string | null; jobs: { id: string; title: string; companies: { name: string } | null } | null }
  const appOf = new Map<string, App>()
  const tieOf = new Map<string, Tie>()
  for (const t of (ties ?? []) as unknown as { contact_id: string; application_id: string; applications: App | null }[]) {
    if (t.applications) appOf.set(t.application_id, t.applications)
    if (t.applications && !tieOf.has(t.contact_id)) tieOf.set(t.contact_id, { applicationId: t.application_id, roleId: t.applications.jobs?.id ?? null, roleTitle: t.applications.jobs?.title ?? 'A role', company: t.applications.jobs?.companies?.name ?? '', stage: t.applications.stage })
  }
  const names = new Map<string, string>()
  const empIds = [...new Set(people.map((p) => p.employer_id).filter((x): x is string => !!x))]
  if (empIds.length) for (const e of ((await db.from('company_directory').select('id, name').in('id', empIds.slice(0, 150))).data ?? []) as { id: string; name: string }[]) names.set(e.id, e.name)

  const out: DueNudge[] = []
  for (const p of people) {
    const byThread = new Map<string, typeof rows>()
    for (const m of rows.filter((r) => r.contact_id === p.contact_id)) byThread.set(m.thread_id ?? m.sent_at, [...(byThread.get(m.thread_id ?? m.sent_at) ?? []), m])
    let best: { n: ReturnType<typeof nudgeFor> & { due: true }; thread: string | null; app: string | null } | null = null
    for (const [thread, ms] of byThread) {
      const appId = ms.find((m) => m.application_id)?.application_id ?? null
      const app = appId ? appOf.get(appId) : undefined
      const closed = !!app && (!!app.closed_reason || CLOSED_STAGES.has(app.stage) || app.state === 'skipped')
      const n = nudgeFor({ thread: ms, rule, person: personRule.get(p.contact_id) ?? null, zone, now, closed, firstName: p.name.split(' ')[0] })
      if (n.due && (!best || n.dueAt < best.n.dueAt)) best = { n, thread: ms[0].thread_id, app: appId }
    }
    if (!best) continue
    out.push({
      contactId: p.contact_id,
      name: p.name,
      firstName: p.name.split(' ')[0],
      email: p.email,
      title: p.title,
      employer: p.employer_id ? (names.get(p.employer_id) ?? null) : null,
      agency: p.agency_name,
      waitingOn: best.n.waitingOn,
      fact: best.n.fact,
      dueAt: best.n.dueAt.toISOString(),
      threadId: best.thread,
      tie: (best.app && tieOf.get(p.contact_id)?.applicationId === best.app ? tieOf.get(p.contact_id) : null) ?? tieOf.get(p.contact_id) ?? null,
      draftId: draftOf.get(p.contact_id) ?? null,
    })
  }
  return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt))
}

/** The follow-up rule a person sees on their page: their own numbers, else the default. */
export async function ruleLine(db: SupabaseClient, userId: string, contactId: string): Promise<{ line: string; own: PersonRule | null; global: NudgeRule }> {
  const [{ rule }, person] = await Promise.all([ruleOf(db, userId), getPerson(db, userId, contactId)])
  const own = (person?.nudge ?? null) as PersonRule | null
  const first = person?.name.split(' ')[0] ?? 'them'
  const yours = own?.after_yours_bd ?? rule.after_yours_bd
  const line = !rule.on || own?.off ? `Cello will not remind you about ${first}.` : `Cello reminds you ${yours} business day${yours === 1 ? '' : 's'} after your last message.`
  return { line, own, global: rule }
}

const DAILY_DRAFTS = 5

/** network.nudge: a draft for each person newly due, under the day's cap. Each draft waits for the person's click. */
export async function draftNudges(
  admin: SupabaseClient,
  user: { id: string; email: string },
  now = new Date(),
  deps: { write?: (brief: { contact_id: string; job_id?: string }) => Promise<{ ok: true; artifactId: string; artifactVersion: number; subject: string; body: string } | { ok: false }> } = {},
): Promise<{ drafted: number; due: number }> {
  const due = (await dueNudges(admin, user.id, now)).filter((d) => !d.draftId && d.email)
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  const { count } = await admin.from('outreach_messages').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('kind', 'follow_up').gte('created_at', start.toISOString())
  let room = DAILY_DRAFTS - (count ?? 0)
  let drafted = 0
  const write = deps.write ?? (async (brief) => {
    const { writeMessage } = await import('@/lib/outreach/write')
    const r = await writeMessage(admin as never, user, { type: 'follow_up', ...brief })
    return r.ok ? { ok: true as const, artifactId: r.written.artifactId, artifactVersion: r.written.artifactVersion, subject: r.written.review.subject, body: r.written.review.body } : { ok: false as const }
  })
  for (const d of due) {
    if (room <= 0) break
    try {
      const w = await write({ contact_id: d.contactId, ...(d.tie?.roleId ? { job_id: d.tie.roleId } : {}) })
      if (!w.ok) continue
      const { insertOutreach } = await import('@/lib/outreach/store')
      await insertOutreach(admin, { user_id: user.id, contact_id: d.contactId, job_id: d.tie?.roleId ?? null, to_email: d.email as string, to_name: d.name, subject: w.subject, body: w.body, kind: 'follow_up', status: 'pending_review', artifact_id: w.artifactId, artifact_version: w.artifactVersion })
      room--
      drafted++
    } catch {
      // one failed draft never stops the rest; the person still sees the row and can write their own
    }
  }
  return { drafted, due: due.length }
}
