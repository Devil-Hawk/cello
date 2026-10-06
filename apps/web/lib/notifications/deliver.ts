// Telling the person, once. The summary and the alerts go to the person's own inbox and their own
// browsers, never to anyone else, and never twice: every delivery claims a row in notification_log
// (one per person, kind and subject) before it goes out, and a failed send gives the row back.
//
// Held back, not lost: quiet hours hold everything but an offer and an interview. Not sent at all: a
// demo; the summary switched off; no Gmail send permission; a second summary within the hour.
// A reply's alert says who wrote about what and where to read it. It never carries their words.
//
// ponytail: the summary goes out by Gmail only, and push carries alerts only. K10's sendToSelf replaces
// the mail sender when it is on main; the port below is its seam.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadNeedsYou } from '@/lib/needs-you'
import { isDemoProfile } from '@/lib/access/guardrails'
import { readPipelineSettings } from '@/lib/pipeline/settings'
import { buildSummary, type SummaryEvent } from '@/lib/pipeline/summary'
import { isQuiet, BREAKS_QUIET } from './quiet'
import { sendPush, type PushResult } from './push'

export type MailResult = 'sent' | 'no_scope' | 'failed'

export interface Deliver {
  admin: SupabaseClient
  /** The one door to the person's own inbox. */
  sendToSelf: (userId: string, subject: string, text: string) => Promise<MailResult>
  push?: typeof sendPush
  now: Date
}

export type SummaryOutcome = 'sent' | 'empty' | 'off' | 'demo' | 'duplicate' | 'too_soon' | 'no_scope' | 'failed' | 'held'

const HOUR = 3_600_000

interface Person {
  preferences: unknown
  isDemo: boolean
  zone: string
}

async function person(admin: SupabaseClient, userId: string): Promise<Person | null> {
  const { data } = await admin.from('profiles').select('preferences, is_demo, demo_expires_at').eq('id', userId).maybeSingle()
  if (!data) return null
  const p = data as { preferences: unknown; is_demo: boolean | null; demo_expires_at: string | null }
  const { data: r } = await admin.from('routines').select('timezone').eq('user_id', userId).eq('command', 'roles.check').maybeSingle()
  return { preferences: p.preferences, isDemo: isDemoProfile(p), zone: (r as { timezone?: string } | null)?.timezone ?? 'UTC' }
}

/** Claim a delivery. False when this person already has it. */
async function claim(admin: SupabaseClient, userId: string, kind: string, subject: string, channel: 'email' | 'push'): Promise<boolean> {
  const { error } = await admin.from('notification_log').insert({ user_id: userId, kind, subject_id: subject, channel })
  return !error
}

async function release(admin: SupabaseClient, userId: string, kind: string, subject: string): Promise<void> {
  await admin.from('notification_log').delete().eq('user_id', userId).eq('kind', kind).eq('subject_id', subject)
}

const dayKey = (now: Date, zone: string) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

const SUMMARY_KINDS = ['submission.sent', 'submission.unconfirmed', 'fill.blocked', 'application.created', 'message.received']

/** The daily summary, to the person's own inbox. */
export async function sendSummary(d: Deliver, userId: string): Promise<SummaryOutcome> {
  const p = await person(d.admin, userId)
  if (!p || p.isDemo) return 'demo'
  const settings = readPipelineSettings(p.preferences)
  if (!settings.summary) return 'off'

  // a second summary within the hour is refused, whatever asked for it
  const { data: last } = await d.admin.from('notification_log').select('sent_at').eq('user_id', userId).eq('kind', 'summary').order('sent_at', { ascending: false }).limit(1).maybeSingle()
  if (last && d.now.getTime() - new Date((last as { sent_at: string }).sent_at).getTime() < HOUR) return 'too_soon'

  const since = new Date(d.now.getTime() - 24 * HOUR).toISOString()
  const { data: events } = await d.admin
    .from('pipeline_events')
    .select('kind, actor, trust, company_name')
    .eq('user_id', userId)
    .gte('created_at', since)
    .limit(500)
  const list = await loadNeedsYou(d.admin, userId, d.now)
  const s = buildSummary({ events: ((events ?? []) as SummaryEvent[]).filter((e) => SUMMARY_KINDS.includes(e.kind)), needsYouCount: list.count, paused: settings.pausedAt !== null })
  if (s.empty) return 'empty'

  const day = dayKey(d.now, p.zone)
  if (!(await claim(d.admin, userId, 'summary', day, 'email'))) return 'duplicate'
  const r = await d.sendToSelf(userId, s.subject, `${s.lines.join('\n')}\n\nOpen Cello to see them.`)
  if (r === 'sent') return 'sent'
  await release(d.admin, userId, 'summary', day)
  return r
}

export interface Alert {
  /** offer_due, interview, reply, ... */
  kind: string
  /** The application or question it is about. */
  subjectId: string
  company: string
  role: string | null
  url: string
}

const ALERT_WORDS: Record<string, (a: Alert) => string> = {
  offer_due: (a) => `${a.company} made you an offer${a.role ? ` for ${a.role}` : ''}.`,
  interview: (a) => `${a.company} wants to talk${a.role ? ` about ${a.role}` : ''}.`,
  reply: (a) => `${a.company} wrote to you${a.role ? ` about ${a.role}` : ''}.`,
}

/** The sentence of an alert: who and about what, never what they wrote. */
export function alertText(a: Alert): string {
  return (ALERT_WORDS[a.kind] ?? ((x: Alert) => `${x.company} has news for you.`))(a)
}

export type AlertOutcome = { email: SummaryOutcome | 'skipped'; push: PushResult | 'duplicate' | 'held' | 'none' }

/** One alert, once per channel, outside quiet hours unless it is an offer or an interview. */
export async function sendAlert(d: Deliver, userId: string, a: Alert): Promise<AlertOutcome> {
  const p = await person(d.admin, userId)
  if (!p || p.isDemo) return { email: 'demo', push: 'none' }
  const settings = readPipelineSettings(p.preferences)
  if (isQuiet(d.now, p.zone, settings.morning.quietFrom, settings.morning.quietTo) && !BREAKS_QUIET.includes(a.kind)) return { email: 'held', push: 'held' }

  const text = alertText(a)
  const out: AlertOutcome = { email: 'skipped', push: 'none' }

  if (settings.summary) {
    if (await claim(d.admin, userId, `${a.kind}:email`, a.subjectId, 'email')) {
      const r = await d.sendToSelf(userId, text, `${text}\n\nOpen Cello to read it.`)
      if (r !== 'sent') await release(d.admin, userId, `${a.kind}:email`, a.subjectId)
      out.email = r
    } else out.email = 'duplicate'
  } else out.email = 'off'

  const { data: subs } = await d.admin.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId).limit(10)
  const list = (subs ?? []) as { id: string; endpoint: string; p256dh: string; auth: string }[]
  if (list.length) {
    if (await claim(d.admin, userId, `${a.kind}:push`, a.subjectId, 'push')) {
      const send = d.push ?? sendPush
      let result: PushResult = 'failed'
      for (const s of list) {
        const r = await send(s, { title: 'Cello', body: text, url: a.url })
        if (r === 'gone') await d.admin.from('push_subscriptions').delete().eq('id', s.id).eq('user_id', userId)
        if (r === 'sent') result = 'sent'
        else if (result !== 'sent') result = r
      }
      if (result !== 'sent') await release(d.admin, userId, `${a.kind}:push`, a.subjectId)
      out.push = result
    } else out.push = 'duplicate'
  }
  return out
}
