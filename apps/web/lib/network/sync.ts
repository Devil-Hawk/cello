// network.sync: people from mail headers, inside inbox.sync. Headers only (blueprint 8): the filter of
// ./filter.ts decides who is a person, ./ties.ts which employer, and a `messages` row with no excerpt is
// written for each message of every thread a person was kept from, so last in touch covers people with no
// application. Never a model, never a body, never a company.
//
// Cursor, left-out counts and the last 200 left-out addresses live in this job's heartbeat (`found`).

import type { SupabaseClient } from '@supabase/supabase-js'
import { contactKind } from '@/lib/contacts/kind'
import { fetchGmailAddress, fetchSendAs, fetchThreadHeaders, listThreadIds, type ThreadHeaders } from '@/lib/gmail/gmail-api'
import { domainOf, judge, parseAddress, parseAddressList, type Candidate, type LeftOutCounts, type LeftOutRule, type MessageHeaders, type Verdict } from './filter'
import { employerTie } from './ties'

// ponytail: 50 threads a tick, newest first; a first sync reaches back only as far as those 50 and
// the rest arrive through Import. Raise it with a queue if first syncs need more.
export const THREADS_PER_TICK = 50
const LEFT_OUT_KEPT = 200

export interface ParsedMessage {
  id: string
  sentAt: string
  direction: 'in' | 'out'
  from: Candidate | null
  to: Candidate[]
  cc: Candidate[]
  subject: string
  headers: Omit<MessageHeaders, 'from'>
}

const header = (h: ThreadHeaders['messages'][number]['headers'], name: string) => h.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? ''

/** A thread's headers as messages, direction from the From address against the person's own addresses. */
export function parseThread(t: ThreadHeaders, yours: Set<string>): ParsedMessage[] {
  return t.messages.map((m) => {
    const from = parseAddress(header(m.headers, 'From'))
    const ms = Number(m.internalDate)
    const date = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(header(m.headers, 'Date'))
    return {
      id: m.id,
      sentAt: (Number.isNaN(date.getTime()) ? new Date() : date).toISOString(),
      direction: from && yours.has(from.email) ? 'out' : 'in',
      from,
      to: parseAddressList(header(m.headers, 'To')),
      cc: parseAddressList(header(m.headers, 'Cc')),
      subject: header(m.headers, 'Subject').slice(0, 200),
      headers: {
        listId: header(m.headers, 'List-Id') || undefined,
        listUnsubscribe: header(m.headers, 'List-Unsubscribe') || undefined,
        precedence: header(m.headers, 'Precedence') || undefined,
        autoSubmitted: header(m.headers, 'Auto-Submitted') || undefined,
      },
    }
  })
}

export interface ThreadRead {
  kept: Extract<Verdict, { keep: true }>[]
  left: Extract<Verdict, { keep: false }>[]
}

/**
 * Who a thread keeps. In mail they sent, the sender is the candidate (with that mail's own headers); in mail
 * the person sent, each recipient is, but only in a job thread: elsewhere a person is kept only when they wrote
 * back. A later mail that passes keeps an address an earlier one left out.
 */
export function readThread(msgs: ParsedMessage[], yours: Set<string>, ctx: { job: boolean; verified: (domain: string) => boolean }): ThreadRead {
  const wroteBack = new Set(msgs.filter((m) => m.direction === 'in' && m.from).map((m) => m.from!.email))
  const wrote = msgs.some((m) => m.direction === 'out')
  const verdicts = new Map<string, Verdict>()
  const consider = (c: Candidate, headers: ParsedMessage['headers'] | undefined) => {
    if (yours.has(c.email)) return
    const v = judge(c, headers, { job: ctx.job, twoWay: wrote && wroteBack.has(c.email), verifiedDomain: ctx.verified(domainOf(c.email)) })
    const had = verdicts.get(c.email)
    if (!had || (v.keep && !had.keep)) verdicts.set(c.email, v)
  }
  for (const m of msgs) {
    if (m.direction === 'in' && m.from) consider(m.from, m.headers)
    else if (m.direction === 'out' && ctx.job) for (const c of [...m.to, ...m.cc]) consider(c, undefined)
  }
  const all = [...verdicts.values()]
  return { kept: all.filter((v): v is ThreadRead['kept'][number] => v.keep), left: all.filter((v): v is ThreadRead['left'][number] => !v.keep) }
}

export interface SyncFound {
  cursor?: number
  sendAs?: string[]
  leftOut?: { counts: LeftOutCounts; addresses: { email: string; rule: LeftOutRule }[] }
  note?: string
  people?: number
}

export interface NetworkSyncResult {
  people: number
  threads: number
  /** Job threads read this tick, for network.remember. */
  jobThreads: { threadId: string; contactIds: string[]; applicationId: string | null; employerId: string | null; messageIds: string[] }[]
  found: SyncFound
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** The person's mail, read as people. `previous` is the heartbeat's last `found`. Never throws past the caller's timeout. */
export async function networkSync(
  admin: SupabaseClient,
  a: { userId: string; accessToken: string; previous: SyncFound; now?: Date },
): Promise<NetworkSyncResult> {
  const now = a.now ?? new Date()
  const found: SyncFound = { ...a.previous }

  // the person's own addresses, from Gmail's send-as list; read once, kept in the heartbeat
  if (!found.sendAs?.length) {
    const own = await fetchGmailAddress(a.accessToken)
    const aliases = await fetchSendAs(a.accessToken)
    found.sendAs = [...new Set([...(own ? [own] : []), ...aliases])]
    if (!aliases.length) found.note = 'Gmail did not give the send-as list, so only the main address counts as you.'
  }
  const yours = new Set(found.sendAs)

  const since = found.cursor ? new Date(found.cursor * 1000).toISOString() : new Date(now.getTime() - 365 * 86_400_000).toISOString()
  const { data: jobRows } = await admin
    .from('messages')
    .select('thread_id')
    .eq('user_id', a.userId)
    .gte('sent_at', since)
    .or('application_id.not.is.null,kind.eq.recruiter')
    .not('thread_id', 'is', null)
    .limit(200)
  const jobIds = [...new Set(((jobRows ?? []) as { thread_id: string }[]).map((r) => r.thread_id))]
  const sentIds = await listThreadIds(a.accessToken, found.cursor ? `in:sent after:${found.cursor}` : 'in:sent newer_than:365d', 100)
  const ids = [...new Set([...jobIds, ...sentIds])].slice(0, THREADS_PER_TICK)
  const jobSet = new Set(jobIds)

  const threads = (await Promise.all(ids.map((id) => fetchThreadHeaders(a.accessToken, id)))).filter((t): t is ThreadHeaders => !!t)
  const parsed = threads.map((t) => ({ id: t.id, msgs: parseThread(t, yours) }))

  // verified employer domains among every address seen
  const domains = new Set<string>()
  for (const t of parsed) for (const m of t.msgs) for (const c of [m.from, ...m.to, ...m.cc]) if (c && !yours.has(c.email)) domains.add(domainOf(c.email))
  const directory = new Map<string, string>()
  if (domains.size) {
    const { data } = await admin.from('company_directory').select('id, domain').in('domain', [...domains]).not('verified_at', 'is', null)
    for (const r of (data ?? []) as { id: string; domain: string }[]) directory.set(r.domain.toLowerCase(), r.id)
  }

  // what K19 already knows about these threads: the application and the employer the mail is about
  const known = new Map<string, { applicationId: string | null; employerId: string | null }>()
  if (ids.length) {
    const { data } = await admin.from('messages').select('thread_id, application_id, employer_id').eq('user_id', a.userId).in('thread_id', ids.slice(0, 50))
    for (const r of (data ?? []) as { thread_id: string; application_id: string | null; employer_id: string | null }[]) {
      const k = known.get(r.thread_id) ?? { applicationId: null, employerId: null }
      known.set(r.thread_id, { applicationId: k.applicationId ?? r.application_id, employerId: k.employerId ?? r.employer_id })
    }
  }

  const leftSeen = new Map((found.leftOut?.addresses ?? []).map((l) => [l.email, l.rule]))
  const counts: LeftOutCounts = { ...(found.leftOut?.counts ?? {}) }
  const result: NetworkSyncResult = { people: 0, threads: 0, jobThreads: [], found }
  const contactIdOf = new Map<string, string>()

  for (const t of parsed) {
    const job = jobSet.has(t.id) || !!known.get(t.id)?.applicationId
    const read = readThread(t.msgs, yours, { job, verified: (d) => directory.has(d) })
    for (const l of read.left) {
      if (leftSeen.has(l.email)) continue
      leftSeen.set(l.email, l.rule)
      counts[l.rule] = (counts[l.rule] ?? 0) + 1
    }
    if (read.kept.length === 0) continue
    result.threads += 1
    const thread = known.get(t.id) ?? { applicationId: null, employerId: null }

    for (const p of read.kept) {
      let id = contactIdOf.get(p.email)
      if (!id) {
        id = (await upsertPerson(admin, a.userId, p, t.msgs, { domainEmployerId: directory.get(p.domain) ?? null, threadEmployerId: thread.employerId })) ?? undefined
        if (!id) continue
        contactIdOf.set(p.email, id)
        result.people += 1
      }
      if (thread.applicationId) {
        await admin.from('contact_applications').upsert({ user_id: a.userId, contact_id: id, application_id: thread.applicationId, origin: 'code' }, { onConflict: 'contact_id,application_id', ignoreDuplicates: true })
      }
    }

    // a row for every message of the thread; K19's row, when it has one, wins
    const keptByEmail = new Map(read.kept.map((p) => [p.email, contactIdOf.get(p.email)]))
    const rows = t.msgs.map((m) => {
      const other = m.direction === 'in' ? m.from?.email : [...m.to, ...m.cc].map((c) => c.email).find((e) => keptByEmail.has(e))
      return { m, contactId: (other && keptByEmail.get(other)) || null }
    })
    await admin.from('messages').upsert(
      rows.map(({ m, contactId }) => ({
        user_id: a.userId,
        gmail_message_id: m.id,
        thread_id: t.id,
        application_id: thread.applicationId,
        contact_id: contactId,
        direction: m.direction,
        sent_at: m.sentAt,
        from_domain: m.from ? domainOf(m.from.email) : null,
        subject: m.subject,
        excerpt: null,
      })),
      { onConflict: 'user_id,gmail_message_id', ignoreDuplicates: true },
    )
    for (const [cid, rs] of groupBy(rows.filter((r) => r.contactId), (r) => r.contactId as string)) {
      await admin.from('messages').update({ contact_id: cid }).eq('user_id', a.userId).in('gmail_message_id', rs.map((r) => r.m.id).slice(0, 100)).is('contact_id', null)
    }
    if (job) {
      result.jobThreads.push({ threadId: t.id, contactIds: [...new Set(read.kept.map((p) => contactIdOf.get(p.email)).filter((x): x is string => !!x))], applicationId: thread.applicationId, employerId: thread.employerId, messageIds: t.msgs.map((m) => m.id) })
    }
  }

  found.cursor = Math.floor(now.getTime() / 1000) - 60
  found.leftOut = { counts, addresses: [...leftSeen].slice(-LEFT_OUT_KEPT).map(([email, rule]) => ({ email, rule })) }
  found.people = (found.people ?? 0) + result.people
  return result
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x])
  return m
}

/** Make or update one person by address. What the person set (kind, employer by hand) is never overwritten. */
async function upsertPerson(
  admin: SupabaseClient,
  userId: string,
  p: Extract<Verdict, { keep: true }>,
  msgs: ParsedMessage[],
  tie: { domainEmployerId: string | null; threadEmployerId: string | null },
): Promise<string | null> {
  const subject = msgs.find((m) => m.from?.email === p.email)?.subject ?? ''
  const { kind, agencyName } = contactKind({ displayName: p.name, address: p.email, subject, body: '' })
  const employer = employerTie({ addressKind: p.addressKind, domainEmployerId: tie.domainEmployerId, threadEmployerId: tie.threadEmployerId, agencyName })
  const firstSeen = msgs.map((m) => m.sentAt).sort()[0]
  const { data: have } = await admin
    .from('contacts')
    .select('id, kind, address_kind, first_seen_at, employer_id, employer_origin, agency_name')
    .eq('user_id', userId)
    .ilike('email', escapeLike(p.email))
    .limit(1)
    .maybeSingle()
  const row = have as { id: string; kind: string | null; address_kind: string | null; first_seen_at: string | null; employer_id: string | null; employer_origin: string | null; agency_name: string | null } | null
  const employerPatch = employer && (!row || !row.employer_id || row.employer_origin === 'code')
    ? { employer_id: employer.employerId, agency_name: employer.agencyName ?? row?.agency_name ?? null, employer_origin: 'code', employer_prov: employer.prov }
    : {}
  if (row) {
    await admin.from('contacts').update({
      address_kind: row.address_kind ?? p.addressKind,
      first_seen_at: row.first_seen_at ?? firstSeen,
      kind: row.kind ?? kind,
      ...employerPatch,
    }).eq('id', row.id).eq('user_id', userId)
    return row.id
  }
  const { data: made } = await admin
    .from('contacts')
    .insert({ user_id: userId, name: p.name.slice(0, 200), email: p.email, source: 'gmail', address_kind: p.addressKind, first_seen_at: firstSeen, kind, ...employerPatch })
    .select('id')
    .single()
  return (made as { id: string } | null)?.id ?? null
}
