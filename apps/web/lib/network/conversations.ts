// What waits in Conversations, by code over messages and contacts: replies waiting on the person, new mail from
// recruiters, and people to write to. Drafts and sent mail come from outreach_messages (the routes the cards use).
// A reply waits when the last message of its thread is theirs and the person has not marked it handled; a reply
// answered from Gmail clears on the next read, because the thread's last message is then the person's.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ReplyRow {
  id: string
  threadId: string
  from: string | null
  contactId: string | null
  subject: string
  excerpt: string | null
  sentAt: string
  /** The reply's kind as Cello's read: interview, offer, rejection, recruiter, reply. */
  kind: string
  applicationId: string | null
  /** The application's role, when the thread has one. */
  role: { id: string; title: string; company: string } | null
  contact: { name: string; title: string | null; employer: string | null } | null
}

export interface WriteToRow {
  id: string
  name: string
  title: string | null
  employer: string | null
  why: string
}

export interface ConversationsData {
  replies: ReplyRow[]
  recruiters: ReplyRow[]
  writeTo: WriteToRow[]
  /** Gmail has been read for this person at least once. */
  gmailConnected: boolean
}

const DAY = 86_400_000

export async function readConversations(db: SupabaseClient, userId: string, now = new Date()): Promise<ConversationsData> {
  const { data: inbound } = await db
    .from('messages')
    .select('id, thread_id, contact_id, subject, excerpt, sent_at, kind, application_id')
    .eq('user_id', userId)
    .eq('direction', 'in')
    .is('handled_at', null)
    .in('kind', ['reply', 'interview', 'offer', 'recruiter', 'rejection'])
    .order('sent_at', { ascending: false })
    .limit(100)
  const rows = (inbound ?? []) as { id: string; thread_id: string | null; contact_id: string | null; subject: string; excerpt: string | null; sent_at: string; kind: string; application_id: string | null }[]
  // one per thread, the newest
  const byThread = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!byThread.has(r.thread_id ?? r.id)) byThread.set(r.thread_id ?? r.id, r)
  const threads = [...byThread.keys()]

  // a thread the person wrote last is not waiting on them
  const { data: outs } = threads.length
    ? await db.from('messages').select('thread_id, sent_at').eq('user_id', userId).eq('direction', 'out').in('thread_id', threads.slice(0, 100))
    : { data: [] }
  const lastOut = new Map<string, string>()
  for (const o of (outs ?? []) as { thread_id: string; sent_at: string }[]) if (!lastOut.has(o.thread_id) || o.sent_at > lastOut.get(o.thread_id)!) lastOut.set(o.thread_id, o.sent_at)
  const waiting = [...byThread.values()].filter((r) => !r.thread_id || !lastOut.has(r.thread_id) || lastOut.get(r.thread_id)! < r.sent_at)

  const contactIds = [...new Set(waiting.map((r) => r.contact_id).filter((x): x is string => !!x))]
  const appIds = [...new Set(waiting.map((r) => r.application_id).filter((x): x is string => !!x))]
  const [{ data: contacts }, { data: apps }] = await Promise.all([
    contactIds.length ? db.from('contact_touch').select('contact_id, name, title, employer_id, agency_name').eq('user_id', userId).in('contact_id', contactIds.slice(0, 100)) : { data: [] },
    appIds.length ? db.from('applications').select('id, jobs(id, title, companies(name))').eq('user_id', userId).in('id', appIds.slice(0, 100)) : { data: [] },
  ])
  const employerIds = [...new Set(((contacts ?? []) as { employer_id: string | null }[]).map((c) => c.employer_id).filter((x): x is string => !!x))]
  const employers = new Map<string, string>()
  if (employerIds.length) for (const e of ((await db.from('company_directory').select('id, name').in('id', employerIds.slice(0, 100))).data ?? []) as { id: string; name: string }[]) employers.set(e.id, e.name)
  const contactOf = new Map(((contacts ?? []) as { contact_id: string; name: string; title: string | null; employer_id: string | null; agency_name: string | null }[]).map((c) => [c.contact_id, { name: c.name, title: c.title, employer: (c.employer_id ? employers.get(c.employer_id) : null) ?? (c.agency_name ? `Agency: ${c.agency_name}` : null) }]))
  const roleOf = new Map(((apps ?? []) as unknown as { id: string; jobs: { id: string; title: string; companies: { name: string } | null } | null }[]).map((a) => [a.id, a.jobs ? { id: a.jobs.id, title: a.jobs.title, company: a.jobs.companies?.name ?? '' } : null]))

  const shape = (r: (typeof rows)[number]): ReplyRow => ({
    id: r.id,
    threadId: r.thread_id ?? r.id,
    from: r.contact_id ? (contactOf.get(r.contact_id)?.name ?? null) : null,
    contactId: r.contact_id,
    subject: r.subject,
    excerpt: r.excerpt ? r.excerpt.split('\n').slice(0, 6).join('\n') : null,
    sentAt: r.sent_at,
    kind: r.kind,
    applicationId: r.application_id,
    role: r.application_id ? (roleOf.get(r.application_id) ?? null) : null,
    contact: r.contact_id ? (contactOf.get(r.contact_id) ?? null) : null,
  })

  const fresh = now.getTime() - 14 * DAY
  const recruiters = waiting.filter((r) => r.kind === 'recruiter' && !r.application_id && new Date(r.sent_at).getTime() >= fresh).map(shape)
  const replies = waiting.filter((r) => !recruiters.some((x) => x.id === r.id)).map(shape)

  // people to write to: in the network, nothing exchanged yet
  const { data: quiet } = await db
    .from('contact_touch')
    .select('contact_id, name, title, kind, employer_id, agency_name, address_kind')
    .eq('user_id', userId)
    .eq('sent_n', 0)
    .eq('received_n', 0)
    .is('last_contact_at', null)
    .order('created_at', { ascending: false })
    .limit(5)
  const writeTo = ((quiet ?? []) as { contact_id: string; name: string; title: string | null; employer_id: string | null; agency_name: string | null }[]).map((c) => ({
    id: c.contact_id,
    name: c.name,
    title: c.title,
    employer: c.agency_name ? `Agency: ${c.agency_name}` : (c.employer_id ? (employers.get(c.employer_id) ?? null) : null),
    why: 'In your network, and you have not written to them yet.',
  }))
  const { data: beat } = await db.from('job_heartbeats').select('job').eq('user_id', userId).eq('job', 'inbox.sync').limit(1).maybeSingle()
  return { replies, recruiters, writeTo, gmailConnected: !!beat }
}
