// Pure daily-digest assembly: a snapshot of stored state in, a composed digest
// out. No database, no network, no model, so it runs the same in the cron, the
// request handler and the evals.
//
// Each line is a plain sentence with the exact numbers, the reason it is on the
// list, and where to act on it. Nothing is padded: a section with nothing to say
// is left out, and an empty digest says what Cello is watching and what to do
// next.

import { STAGE_META, type PipelineStage } from '@/lib/format'
import { utcDateKey, type ComposedDigest, type DigestItem, type DigestSection, type DigestSectionId } from './types'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_ITEMS = 5
const NEW_ROLE_DAYS = 7
const QUIET_DAYS = 7
const REPLY_DAYS = 14
/** Fewer sent emails than this is too little to say what is working. */
const MIN_SENT_TO_JUDGE = 5

export const DEFAULT_APP_URL = 'https://cello-two.vercel.app'

export interface DigestReply {
  name: string | null
  company: string | null
  jobTitle: string | null
  repliedAt: string
}

export interface DigestFollowUp {
  name: string | null
  company: string | null
  sentAt: string
}

export interface DigestRole {
  id: string
  title: string
  company: string | null
  url: string | null
  /** strong | possible | stretch | cannot_assess, or null before the role was assessed for this person. */
  chance: string | null
  /** How likely this person is to want it (0 to 1). Orders the list; never shown. */
  want: number | null
  /** Why they might want it, in their terms, when Cello wrote one. */
  reason: string | null
  discoveredAt: string
  stillOpen: boolean | null
  /** The user has an application row for this role. */
  hasApplication: boolean
}

export interface DigestApplication {
  id: string
  stage: string
  title: string
  company: string | null
  appliedAt: string | null
  updatedAt: string
}

export interface DigestState {
  companyCount: number
  pendingOutreach: number
  pendingApplications: number
  replies: DigestReply[]
  followUps: DigestFollowUp[]
  roles: DigestRole[]
  applications: DigestApplication[]
  sentLast30: number
  repliesLast30: number
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function daysSince(iso: string | null, now: number): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / DAY_MS))
}

function ago(days: number): string {
  return days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
}

function stageWord(stage: string): string {
  return STAGE_META[stage as PipelineStage]?.label ?? stage
}

/**
 * The reason a role is on the list: the first sentence of the reason Cello wrote
 * for this person, up to 140 characters (cut at a word, never mid-word). With no
 * reason it says what is known and no more.
 */
export function jobReason(reason: string | null, chance: string | null): string {
  const first = (reason ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)[0] ?? ''
  if (first) {
    const cut = first.length <= 140 ? first : first.slice(0, 140).replace(/\s+\S*$/, '')
    return /[.!?]$/.test(cut) ? cut : `${cut}.`
  }
  if (chance === 'strong') return 'Your resume shows what it asks for.'
  if (chance === 'possible') return 'Your resume shows most of what it asks for.'
  return 'Found in the last 7 days.'
}

function at(company: string | null): string {
  return company ? ` at ${company}` : ''
}

export function buildDigest(state: DigestState, now: number = Date.now(), baseUrl: string = DEFAULT_APP_URL): ComposedDigest {
  const sections: DigestSection[] = []
  const add = (id: DigestSectionId, title: string, items: DigestItem[]) => {
    if (items.length > 0) sections.push({ id, title, items })
  }

  add(
    'replies',
    'Replies to answer',
    state.replies
      .filter((r) => daysSince(r.repliedAt, now) <= REPLY_DAYS)
      .sort((a, b) => Date.parse(b.repliedAt) - Date.parse(a.repliedAt))
      .slice(0, MAX_ITEMS)
      .map((r) => ({
        text: `${r.name ?? 'Someone'}${at(r.company)} replied ${ago(daysSince(r.repliedAt, now))}${r.jobTitle ? ` about ${r.jobTitle}` : ''}.`,
        href: '/queue?tab=outreach',
      }))
  )

  const waiting = [
    state.pendingOutreach > 0 ? plural(state.pendingOutreach, 'outreach draft', 'outreach drafts') : '',
    state.pendingApplications > 0 ? plural(state.pendingApplications, 'application', 'applications') : '',
  ].filter(Boolean)
  const waitingTotal = state.pendingOutreach + state.pendingApplications
  add('approvals', 'Waiting for your approval', waiting.length ? [{ text: `${waiting.join(' and ')} ${waitingTotal === 1 ? 'is' : 'are'} waiting for your approval.`, href: '/queue' }] : [])

  add(
    'follow_ups',
    'Follow-ups you can send',
    [...state.followUps]
      .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))
      .slice(0, MAX_ITEMS)
      .map((f) => ({
        text: `No reply from ${f.name ?? 'them'}${at(f.company)} in ${plural(daysSince(f.sentAt, now), 'day', 'days')}. One follow-up is allowed.`,
        href: '/queue?tab=outreach',
      }))
  )

  add(
    'new_roles',
    'New roles worth a look',
    state.roles
      .filter((j) => !j.hasApplication && j.stillOpen !== false && daysSince(j.discoveredAt, now) <= NEW_ROLE_DAYS)
      .sort((a, b) => (b.want ?? -1) - (a.want ?? -1))
      .slice(0, MAX_ITEMS)
      .map((j) => ({ text: `${j.title}${at(j.company)}: ${jobReason(j.reason, j.chance)}`, href: j.url || '/jobs' }))
  )

  add(
    'gone_quiet',
    'Gone quiet',
    state.applications
      .filter((a) => ['applied', 'screen', 'interview'].includes(a.stage) && daysSince(a.updatedAt, now) >= QUIET_DAYS)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .slice(0, MAX_ITEMS)
      .map((a) => ({
        text:
          a.stage === 'applied'
            ? `Applied${a.company ? ` to ${a.company}` : ''} ${ago(daysSince(a.appliedAt ?? a.updatedAt, now))} for ${a.title}, no update since.`
            : `${stageWord(a.stage)}${at(a.company)} for ${a.title}, no update in ${plural(daysSince(a.updatedAt, now), 'day', 'days')}.`,
        href: '/pipeline',
      }))
  )

  const needsYou = sections.length > 0
  // What is working is context, not something that needs the user, so it does
  // not make the digest non-empty on its own.
  add('working', "What's working", [
    {
      text:
        state.sentLast30 >= MIN_SENT_TO_JUDGE
          ? `You sent ${plural(state.sentLast30, 'email', 'emails')} and got ${plural(state.repliesLast30, 'reply', 'replies')} in the last 30 days.`
          : `You sent ${state.sentLast30 === 0 ? 'no emails' : plural(state.sentLast30, 'email', 'emails')} in the last 30 days. Too few to tell what is working yet.`,
      href: null,
    },
  ])

  const empty = !needsYou
  const count = (id: DigestSectionId) => sections.find((s) => s.id === id)?.items.length ?? 0
  const subjectParts = [
    count('replies') ? plural(count('replies'), 'reply', 'replies') : '',
    waitingTotal > 0 ? `${waitingTotal} ${waitingTotal === 1 ? 'draft' : 'drafts'} to approve` : '',
    count('new_roles') ? `${count('new_roles')} new ${count('new_roles') === 1 ? 'role' : 'roles'}` : '',
    count('follow_ups') ? `${count('follow_ups')} ${count('follow_ups') === 1 ? 'follow-up' : 'follow-ups'} to send` : '',
  ].filter(Boolean)
  const subject = empty
    ? 'Cello daily: nothing needs you today'
    : `Cello daily: ${subjectParts.slice(0, 3).join(', ') || plural(sections.filter((s) => s.id !== 'working').reduce((n, s) => n + s.items.length, 0), 'update', 'updates')}`

  const emptyLine =
    state.companyCount > 0
      ? `Nothing needs you today. Cello is watching ${plural(state.companyCount, 'company', 'companies')} and will write when something changes.`
      : 'Nothing needs you today. Add companies to watch and Cello will look for roles there.'

  return {
    date: utcDateKey(new Date(now)),
    subject,
    text: renderText(sections, empty, emptyLine, baseUrl),
    html: renderHtml(sections, empty, emptyLine, baseUrl),
    sections,
    empty,
  }
}

function absolute(href: string | null, baseUrl: string): string | null {
  if (!href) return null
  return href.startsWith('/') ? `${baseUrl.replace(/\/$/, '')}${href}` : href
}

function renderText(sections: DigestSection[], empty: boolean, emptyLine: string, baseUrl: string): string {
  const lines: string[] = []
  if (empty) lines.push(emptyLine, '')
  for (const s of sections) {
    lines.push(s.title)
    for (const i of s.items) {
      const link = absolute(i.href, baseUrl)
      lines.push(`  ${i.text}${link ? ` ${link}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderHtml(sections: DigestSection[], empty: boolean, emptyLine: string, baseUrl: string): string {
  const body = sections
    .map((s) => {
      const items = s.items
        .map((i) => {
          const link = absolute(i.href, baseUrl)
          return `<li style="margin:0 0 8px">${esc(i.text)}${link ? ` <a href="${esc(link)}" style="color:#12706F">Open</a>` : ''}</li>`
        })
        .join('')
      return `<h3 style="font-size:15px;margin:20px 0 8px">${esc(s.title)}</h3><ul style="padding-left:18px;margin:0">${items}</ul>`
    })
    .join('')
  return (
    `<div style="font-family:system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:0 16px;line-height:1.45">` +
    `<h2 style="font-size:18px;margin:16px 0">Cello daily</h2>${empty ? `<p>${esc(emptyLine)}</p>` : ''}${body}</div>`
  )
}
