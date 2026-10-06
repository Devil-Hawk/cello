'use client'

// Conversations (blueprint 4.9): who is waiting on me, what should I send, who could I write to. Six groups in
// one order: replies waiting on you, drafts to approve, follow-ups due, new from recruiters, people to write to,
// sent. A name opens the Person sheet; people live in Network. Nothing leaves without the person's click.

import Link from 'next/link'
import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { LogoTile, RoleTitle } from '@/components/roles/role-tile'
import { OutreachCard, type OutreachRow } from './outreach-card'
import { PersonSheet, type SheetPerson } from './person-sheet'
import { ReplyRow } from './reply-row'
import type { ConversationsData, ReplyRow as Reply } from '@/lib/network/conversations'
import type { DueNudge } from '@/lib/network/nudges'

export interface ConversationsViewProps {
  data: ConversationsData
  outreach: OutreachRow[]
  due: DueNudge[]
  gmailConnected: boolean
  /** The person's daily limit and how many went today, for the limit sentence. */
  limit: { cap: number; sentToday: number }
  onHandled: (messageId: string) => void
  onChanged: () => void
}

/** Drafts that may go in one click: more than one, each with its stored checks all passed. */
export function approveAllIds(drafts: OutreachRow[]): string[] {
  const ready = drafts.filter((d) => d.status === 'pending_review' && d.verdicts && d.verdicts.length > 0 && d.verdicts.every((v) => v.verdict === 'pass'))
  return ready.length > 1 && ready.length === drafts.filter((d) => d.status === 'pending_review').length ? ready.map((d) => d.id) : []
}

export const GROUP_TITLES = ['Replies waiting on you', 'Drafts to approve', 'Follow-ups due', 'New from recruiters', 'People to write to', 'Sent'] as const

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <section aria-labelledby={`cv-${title}`} className="space-y-2">
      <h2 id={`cv-${title}`} className="r-title">{title}</h2>
      <div className="r-sheet px-4">{children}</div>
    </section>
  )
}

export function ConversationsView({ data, outreach, due, gmailConnected, limit, onHandled, onChanged }: ConversationsViewProps) {
  const [sheet, setSheet] = useState<SheetPerson | null>(null)
  const [sendingAll, setSendingAll] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const drafts = outreach.filter((m) => m.kind !== 'follow_up' && (m.status === 'pending_review' || m.status === 'approved' || m.status === 'failed'))
  const followDrafts = new Map(outreach.filter((m) => m.kind === 'follow_up' && m.status === 'pending_review').map((m) => [m.to_email, m]))
  const sent = outreach.filter((m) => m.status === 'sent').slice(0, 10)
  const all = approveAllIds(drafts)
  const nothing = data.replies.length + drafts.length + due.length + data.recruiters.length + data.writeTo.length + sent.length === 0

  const open = (r: Reply) => r.contact && r.contactId && setSheet({ id: r.contactId, name: r.contact.name, title: r.contact.title, employer: r.contact.employer })

  async function sendAll() {
    setSendingAll(true)
    setNote(null)
    let done = 0
    for (const id of all) {
      // one click of the person's, one send per draft, each under the daily limit
      const res = await fetch('/api/outreach/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, approve: true }) })
      if (!res.ok) break
      done++
    }
    setNote(done === all.length ? `Sent ${done}.` : `Sent ${done} of ${all.length}. The rest are waiting for you.`)
    setSendingAll(false)
    onChanged()
  }

  return (
    <div className="space-y-10">
      {!gmailConnected && (
        <section className="r-sheet space-y-3 p-6">
          <p className="r-body">Connect Gmail to see replies here. Cello reads job mail, and the headers of your threads with people at employers&apos; own addresses. It never sends without your click.</p>
          <Key asChild><Link href="/settings?tab=connections">Connect Gmail</Link></Key>
        </section>
      )}
      {limit.sentToday >= limit.cap && <p className="r-body" role="status">{limit.sentToday} sent today, your daily limit. The rest go tomorrow.</p>}
      {note && <p className="r-meta" role="status">{note}</p>}
      {gmailConnected && nothing && <p className="r-body">Nobody is waiting on you.</p>}

      <Group title={GROUP_TITLES[0]} count={data.replies.length}>
        <ul className="divide-y divide-[var(--r-line)]">{data.replies.map((r) => <ReplyRow key={r.id} r={r} onHandled={onHandled} onPerson={open} />)}</ul>
      </Group>

      <Group title={GROUP_TITLES[1]} count={drafts.length}>
        {all.length > 0 && (
          <div className="py-3">
            <Key disabled={sendingAll} onClick={sendAll}>Approve and send all {all.length}</Key>
            <p className="r-meta mt-1">All {all.length} checks passed.</p>
          </div>
        )}
        <div className="space-y-4 py-3">{drafts.map((m) => <OutreachCard key={m.id} message={m} onChanged={onChanged} />)}</div>
      </Group>

      <Group title={GROUP_TITLES[2]} count={due.length}>
        <ul className="divide-y divide-[var(--r-line)]">
          {due.map((d) => {
            const draft = d.email ? followDrafts.get(d.email) : undefined
            return (
              <li key={d.contactId} className="py-3">
                <div className="flex flex-wrap items-start gap-3">
                  <LogoTile name={d.employer ?? d.agency ?? d.name} size={40} />
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="r-name"><Link href={`/network/${d.contactId}`} className="hover:underline">{d.name}</Link></p>
                    {d.tie?.roleId && <RoleTitle id={d.tie.roleId} title={d.tie.roleTitle} company={d.tie.company} layout="inline" />}
                    <p className="r-meta mt-1">{d.fact}</p>
                  </div>
                </div>
                {draft && <div className="mt-3"><OutreachCard message={draft} onChanged={onChanged} /></div>}
              </li>
            )
          })}
        </ul>
      </Group>

      <Group title={GROUP_TITLES[3]} count={data.recruiters.length}>
        <ul className="divide-y divide-[var(--r-line)]">{data.recruiters.map((r) => <ReplyRow key={r.id} r={r} onHandled={onHandled} onPerson={open} />)}</ul>
      </Group>

      <Group title={GROUP_TITLES[4]} count={data.writeTo.length}>
        <ul className="divide-y divide-[var(--r-line)]">
          {data.writeTo.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
              <LogoTile name={p.employer ?? p.name} size={40} />
              <div className="min-w-0 flex-1 basis-56">
                <p className="r-name">
                  <button type="button" className="hover:underline" onClick={() => setSheet({ id: p.id, name: p.name, title: p.title, employer: p.employer })}>{p.name}</button>
                </p>
                <p className="r-meta">{[p.title, p.employer].filter(Boolean).join(' at ')}. {p.why}</p>
              </div>
            </li>
          ))}
        </ul>
      </Group>

      <Group title={GROUP_TITLES[5]} count={sent.length}>
        <div className="space-y-4 py-3">{sent.map((m) => <OutreachCard key={m.id} message={m} onChanged={onChanged} />)}</div>
      </Group>

      <PersonSheet person={sheet} onClose={() => setSheet(null)} />
    </div>
  )
}
