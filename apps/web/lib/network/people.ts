// People, read by code: the list in order (waiting on you, then last in touch), one person with their
// exchanges, ties, profile and rule, and the closeness band. Reads go through the caller's client, so row
// level security scopes them at the session door.

import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateConnectionStrength, calculateDaysSinceContact, getRelationshipType } from '@/lib/contacts/network'

export const PAGE = 100

export type Band = 'Close' | 'In touch' | 'Faint'

export interface Tie {
  applicationId: string
  roleId: string | null
  roleTitle: string
  company: string
  stage: string
}

export interface PersonRow {
  id: string
  name: string
  email: string | null
  title: string | null
  kind: string | null
  addressKind: 'employer' | 'personal' | 'agency' | null
  employerId: string | null
  employer: string | null
  agency: string | null
  lastAt: string | null
  lastFrom: 'you' | 'them' | null
  waitingOn: 'you' | 'them' | 'none'
  sentN: number
  receivedN: number
  threadsN: number
  band: Band
  /** "Former colleague, last in touch 6 days ago": the inputs of the band, on request. */
  bandWhy: string
  ties: Tie[]
  /** Where the person came from, as a sentence. */
  from: string
}

export interface ListQuery {
  q?: string
  kind?: string
  address?: 'employer' | 'personal'
  hasApplication?: boolean
  waitingOnYou?: boolean
  quiet?: boolean
  order?: 'last' | 'closest'
  page?: number
}

interface TouchRow {
  contact_id: string
  name: string
  email: string | null
  title: string | null
  kind: string | null
  address_kind: PersonRow['addressKind']
  employer_id: string | null
  agency_name: string | null
  relationship: string | null
  last_contact_at: string | null
  first_seen_at: string | null
  last_at: string | null
  last_from: 'you' | 'them' | null
  waiting_on: 'you' | 'them' | 'none'
  sent_n: number
  received_n: number
  threads_n: number
}

const RELATIONSHIP_LABEL: Record<string, string> = {
  direct_contact: 'Direct contact',
  former_colleague: 'Former colleague',
  alumni: 'Alumni',
  linkedin_connection: 'LinkedIn connection',
  second_degree: 'Second degree',
  unknown: 'Relationship not set',
}

export function bandOf(relationship: string | null, lastAt: string | null): { band: Band; why: string } {
  const days = lastAt ? calculateDaysSinceContact(new Date(lastAt)) : undefined
  const s = calculateConnectionStrength(relationship, days)
  const ago = days === undefined ? 'no contact recorded' : days === 0 ? 'last in touch today' : `last in touch ${days} day${days === 1 ? '' : 's'} ago`
  return { band: s >= 0.6 ? 'Close' : s >= 0.3 ? 'In touch' : 'Faint', why: `${RELATIONSHIP_LABEL[getRelationshipType(relationship)]}, ${ago}` }
}

const SELECT = 'contact_id, name, email, title, kind, address_kind, employer_id, agency_name, relationship, last_contact_at, first_seen_at, last_at, last_from, waiting_on, sent_n, received_n, threads_n'

async function employerNames(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  const { data } = await db.from('company_directory').select('id, name').in('id', ids.slice(0, 100))
  for (const r of (data ?? []) as { id: string; name: string }[]) out.set(r.id, r.name)
  return out
}

async function tiesFor(db: SupabaseClient, ids: string[]): Promise<Map<string, Tie[]>> {
  const out = new Map<string, Tie[]>()
  if (!ids.length) return out
  const { data } = await db
    .from('contact_applications')
    .select('contact_id, application_id, applications(id, stage, job_id, jobs(id, title, companies(name)))')
    .in('contact_id', ids.slice(0, 100))
  for (const r of (data ?? []) as unknown as {
    contact_id: string
    application_id: string
    applications: { stage: string; job_id: string; jobs: { id: string; title: string; companies: { name: string } | null } | null } | null
  }[]) {
    const job = r.applications?.jobs
    out.set(r.contact_id, [...(out.get(r.contact_id) ?? []), { applicationId: r.application_id, roleId: job?.id ?? null, roleTitle: job?.title ?? 'A role', company: job?.companies?.name ?? '', stage: r.applications?.stage ?? '' }])
  }
  return out
}

function sentence(t: TouchRow): string {
  if (t.address_kind === 'agency') return 'From your email, at an agency.'
  if (t.sent_n + t.received_n > 0) return `From your email: ${t.sent_n + t.received_n} message${t.sent_n + t.received_n === 1 ? '' : 's'}${t.first_seen_at ? ` since ${new Date(t.first_seen_at).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })}` : ''}.`
  return 'Added by you.'
}

function shape(t: TouchRow, employers: Map<string, string>, ties: Map<string, Tie[]>): PersonRow {
  const { band, why } = bandOf(t.relationship, t.last_at)
  return {
    id: t.contact_id,
    name: t.name,
    email: t.email,
    title: t.title,
    kind: t.kind,
    addressKind: t.address_kind,
    employerId: t.employer_id,
    employer: t.employer_id ? (employers.get(t.employer_id) ?? null) : null,
    agency: t.agency_name,
    lastAt: t.last_at,
    lastFrom: t.last_from,
    waitingOn: t.waiting_on,
    sentN: t.sent_n,
    receivedN: t.received_n,
    threadsN: t.threads_n,
    band,
    bandWhy: why,
    ties: ties.get(t.contact_id) ?? [],
    from: sentence(t),
  }
}

/** One page of people, waiting on you first, then last in touch. `total` is the count behind the filters. */
export async function listPeople(db: SupabaseClient, userId: string, q: ListQuery = {}): Promise<{ people: PersonRow[]; total: number; page: number; pages: number }> {
  const page = Math.max(1, q.page ?? 1)
  let query = db.from('contact_touch').select(SELECT, { count: 'exact' }).eq('user_id', userId)
  if (q.kind) query = query.eq('kind', q.kind)
  if (q.address) query = query.eq('address_kind', q.address)
  if (q.waitingOnYou) query = query.eq('waiting_on', 'you')
  if (q.quiet) query = query.lt('last_at', new Date(Date.now() - 30 * 86_400_000).toISOString())
  const term = q.q?.trim().replace(/[%,()*]/g, ' ')
  if (term) {
    const { data: emps } = await db.from('company_directory').select('id').ilike('name', `%${term}%`).limit(20)
    const ids = ((emps ?? []) as { id: string }[]).map((e) => e.id)
    query = query.or([`name.ilike.%${term}%`, `email.ilike.%${term}%`, `agency_name.ilike.%${term}%`, ids.length ? `employer_id.in.(${ids.join(',')})` : ''].filter(Boolean).join(','))
  }
  query = query.order('waiting_on', { ascending: false }).order('last_at', { ascending: false, nullsFirst: false })
  // ponytail: Closest first orders the newest 1,000 people in code; past that Last in touch is the order.
  const closest = q.order === 'closest'
  query = closest ? query.range(0, 999) : query.range((page - 1) * PAGE, page * PAGE - 1)
  const { data, count, error } = await query
  if (error) throw new Error('Could not read your people.')
  let rows = (data ?? []) as unknown as TouchRow[]
  const total = count ?? rows.length
  if (q.hasApplication !== undefined) {
    const withTies = await tiesFor(db, rows.map((r) => r.contact_id))
    rows = rows.filter((r) => ((withTies.get(r.contact_id)?.length ?? 0) > 0) === q.hasApplication)
  }
  if (closest) {
    rows = rows
      .map((r) => ({ r, s: calculateConnectionStrength(r.relationship, r.last_at ? calculateDaysSinceContact(new Date(r.last_at)) : undefined) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.r)
      .slice((page - 1) * PAGE, page * PAGE)
  }
  const [employers, ties] = await Promise.all([employerNames(db, [...new Set(rows.map((r) => r.employer_id).filter((x): x is string => !!x))]), tiesFor(db, rows.map((r) => r.contact_id))])
  return { people: rows.map((r) => shape(r, employers, ties)), total, page, pages: Math.max(1, Math.ceil(total / PAGE)) }
}

export interface Exchange {
  id: string
  direction: 'in' | 'out'
  sentAt: string
  subject: string
  excerpt: string | null
  threadId: string | null
}

export interface PersonDetail extends PersonRow {
  notes: string | null
  linkedinUrl: string | null
  firstSeenAt: string | null
  employerReason: string | null
  nudge: Record<string, unknown> | null
  exchanges: Exchange[]
  profiles: { id: string; url: string; host: string; title: string | null; snippet: string | null; state: string; origin: string; foundAt: string; query: string | null }[]
}

export async function getPerson(db: SupabaseClient, userId: string, id: string): Promise<PersonDetail | null> {
  const { data: t } = await db.from('contact_touch').select(SELECT).eq('user_id', userId).eq('contact_id', id).maybeSingle()
  if (!t) return null
  const touch = t as unknown as TouchRow
  const [{ data: c }, { data: msgs }, { data: profs }, employers, ties] = await Promise.all([
    db.from('contacts').select('notes, linkedin_url, nudge, employer_prov').eq('user_id', userId).eq('id', id).maybeSingle(),
    db.from('messages').select('id, direction, sent_at, subject, excerpt, thread_id').eq('user_id', userId).eq('contact_id', id).order('sent_at', { ascending: false }).limit(50),
    db.from('contact_profiles').select('id, url, host, title, snippet, state, origin, found_at, query').eq('user_id', userId).eq('contact_id', id).neq('state', 'rejected').order('rank'),
    employerNames(db, touch.employer_id ? [touch.employer_id] : []),
    tiesFor(db, [id]),
  ])
  const contact = (c ?? {}) as { notes?: string | null; linkedin_url?: string | null; nudge?: Record<string, unknown> | null; employer_prov?: { rule?: string } | null }
  return {
    ...shape(touch, employers, ties),
    notes: contact.notes ?? null,
    linkedinUrl: contact.linkedin_url ?? null,
    firstSeenAt: touch.first_seen_at,
    employerReason: contact.employer_prov?.rule ?? null,
    nudge: contact.nudge ?? null,
    exchanges: ((msgs ?? []) as { id: string; direction: 'in' | 'out'; sent_at: string; subject: string; excerpt: string | null; thread_id: string | null }[]).map((m) => ({ id: m.id, direction: m.direction, sentAt: m.sent_at, subject: m.subject, excerpt: m.excerpt, threadId: m.thread_id })),
    profiles: ((profs ?? []) as { id: string; url: string; host: string; title: string | null; snippet: string | null; state: string; origin: string; found_at: string; query: string | null }[]).map((p) => ({ id: p.id, url: p.url, host: p.host, title: p.title, snippet: p.snippet, state: p.state, origin: p.origin, foundAt: p.found_at, query: p.query })),
  }
}
