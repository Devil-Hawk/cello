'use client'

// Conversations (blueprint 4.9): who is waiting on me, what should I send, who could I write to. Six groups in
// one order: replies waiting on you, drafts to approve, follow-ups due, new from recruiters, people to write to,
// sent. A name opens the Person sheet; people live in Network. Nothing leaves without the person's click.

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Key } from '@/components/ui/key'
import { LogoTile, RoleTitle } from '@/components/roles/role-tile'
import type { MenuDialog } from './conversation-menu'
import { OutreachCard, type OutreachRow } from './outreach-card'
import { PersonSheet, type SheetPerson } from './person-sheet'
import { ReplyRow } from './reply-row'
import type { ConversationsData, ReplyRow as Reply } from '@/lib/network/conversations'
import type { DueNudge } from '@/lib/network/nudges'

const MenuDialogs = dynamic(() => import('./conversation-menu').then((m) => m.MenuDialogs), { ssr: false })

export interface ConversationsViewProps {
  data: ConversationsData
  outreach: OutreachRow[]
  due: DueNudge[]
  gmailConnected: boolean
  /** The person's daily limit and how many went today, for the limit sentence. */
  limit: { cap: number; sentToday: number }
  onHandled: (messageId: string) => void
  onChanged: () => void
  /** The draft a link asked for (?draft=): scrolled to and marked. */
  focusDraft?: string | null
}

/** Drafts that may go in one click: more than one, each with its stored checks all passed. */
export function approveAllIds(drafts: OutreachRow[]): string[] {
  const ready = drafts.filter((d) => d.status === 'pending_review' && d.verdicts && d.verdicts.length > 0 && d.verdicts.every((v) => v.verdict === 'pass'))
  return ready.length > 1 && ready.length === drafts.filter((d) => d.status === 'pending_review').length ? ready.map((d) => d.id) : []
}

/** Send each ready draft in turn, one request per draft, and stop at the first the daily limit or Gmail refuses. */
export async function sendDrafts(ids: string[], post: (id: string) => Promise<{ ok: boolean }>): Promise<number> {
  let done = 0
  for (const id of ids) {
    if (!(await post(id)).ok) break
    done++
  }
  return done
}

const postSend = (id: string) => fetch('/api/outreach/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, approve: true }) })

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

export function ConversationsView({ data, outreach, due, gmailConnected, limit, onHandled, onChanged, focusDraft }: ConversationsViewProps) {
  const [sheet, setSheet] = useState<SheetPerson | null>(null)
  const [sendingAll, setSendingAll] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [dialog, setDialog] = useState<MenuDialog>(null)
  const [menu, setMenu] = useState(false)
  const choose = (d: MenuDialog) => {
    setMenu(false)
    setDialog(d)
  }

  const drafts = outreach.filter((m) => m.kind !== 'follow_up' && (m.status === 'pending_review' || m.status === 'approved' || m.status === 'failed'))
  const followDrafts = new Map(outreach.filter((m) => m.kind === 'follow_up' && m.status === 'pending_review').map((m) => [m.to_email, m]))
  const sent = outreach.filter((m) => m.status === 'sent').slice(0, 10)
  const all = approveAllIds(drafts)
  const nothing = data.replies.length + drafts.length + due.length + data.recruiters.length + data.writeTo.length + sent.length === 0

  const open = (r: Reply) => r.contact && r.contactId && setSheet({ id: r.contactId, name: r.contact.name, title: r.contact.title, employer: r.contact.employer, email: r.contact.email })

  // a link from Network lands on its draft
  const hasFocus = !!focusDraft && outreach.some((m) => m.id === focusDraft)
  useEffect(() => {
    if (hasFocus) document.getElementById(`draft-${focusDraft}`)?.scrollIntoView({ block: 'center' })
  }, [hasFocus, focusDraft])
  const card = (m: OutreachRow) => (
    <div key={m.id} id={`draft-${m.id}`} className={focusDraft === m.id ? 'rounded-[12px] ring-2 ring-[var(--r-ink)]' : undefined}>
      <OutreachCard message={m} onChanged={onChanged} />
    </div>
  )

  async function sendAll() {
    setSendingAll(true)
    setNote(null)
    // one click of the person's, one send per draft, each under the daily limit
    const done = await sendDrafts(all, postSend)
    setNote(done === all.length ? `Sent ${done}.` : `Sent ${done} of ${all.length}. The rest are waiting for you.`)
    setSendingAll(false)
    onChanged()
  }

  return (
    <div className="space-y-10">
      <div className="flex justify-end">
        <details className="relative" open={menu} onToggle={(e) => setMenu(e.currentTarget.open)}>
          <summary aria-label="Conversations menu" className="r-key r-key-raised grid min-h-11 min-w-11 cursor-pointer list-none place-items-center">
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </summary>
          <div className="r-sheet absolute right-0 z-20 mt-2 w-60 p-1">
            <button type="button" className="block min-h-11 w-full px-3 text-left hover:underline" onClick={() => choose('paste')}>Paste an email</button>
            <button type="button" className="block min-h-11 w-full px-3 text-left hover:underline" onClick={() => choose('find')}>Find people at a company</button>
          </div>
        </details>
      </div>
      {!gmailConnected && (
        <section className="r-sheet space-y-3 p-6">
          <p className="r-body">Connect Gmail to see replies here, or paste an email. Cello reads job mail, and the headers of your threads with people at employers&apos; own addresses. It never sends without your click.</p>
          <div className="flex flex-wrap gap-2">
            <Key asChild><Link href="/settings?tab=connections">Connect Gmail</Link></Key>
            <Key variant="raised" onClick={() => choose('paste')}>Paste an email</Key>
          </div>
        </section>
      )}
      {limit.sentToday >= limit.cap && <p className="r-body" role="status">{limit.sentToday} sent today, your daily limit. The rest go tomorrow.</p>}
      {note && <p className="r-meta" role="status">{note}</p>}
      {gmailConnected && nothing && <p className="r-body">Nobody is waiting on you.</p>}

      <Group title={GROUP_TITLES[0]} count={data.replies.length}>
        <ul className="divide-y divide-[var(--r-line)]">{data.replies.map((r) => <ReplyRow key={r.id} r={r} onHandled={onHandled} onPerson={open} onDrafted={onChanged} />)}</ul>
      </Group>

      <Group title={GROUP_TITLES[1]} count={drafts.length}>
        {all.length > 0 && (
          <div className="py-3">
            <Key disabled={sendingAll} onClick={sendAll}>Approve and send all {all.length}</Key>
            <p className="r-meta mt-1">All {all.length} checks passed.</p>
          </div>
        )}
        <div className="space-y-4 py-3">{drafts.map(card)}</div>
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
                {draft && <div className="mt-3">{card(draft)}</div>}
              </li>
            )
          })}
        </ul>
      </Group>

      <Group title={GROUP_TITLES[3]} count={data.recruiters.length}>
        <ul className="divide-y divide-[var(--r-line)]">{data.recruiters.map((r) => <ReplyRow key={r.id} r={r} onHandled={onHandled} onPerson={open} onDrafted={onChanged} />)}</ul>
      </Group>

      <Group title={GROUP_TITLES[4]} count={data.writeTo.length}>
        <ul className="divide-y divide-[var(--r-line)]">
          {data.writeTo.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
              <LogoTile name={p.employer ?? p.name} size={40} />
              <div className="min-w-0 flex-1 basis-56">
                <p className="r-name">
                  <button type="button" className="hover:underline" onClick={() => setSheet({ id: p.id, name: p.name, title: p.title, employer: p.employer, email: p.email })}>{p.name}</button>
                </p>
                <p className="r-meta">{[p.title, p.employer].filter(Boolean).join(' at ')}. {p.why}</p>
              </div>
            </li>
          ))}
        </ul>
      </Group>

      <Group title={GROUP_TITLES[5]} count={sent.length}>
        <div className="space-y-4 py-3">{sent.map(card)}</div>
      </Group>

      <PersonSheet person={sheet} onClose={() => setSheet(null)} />
      {dialog && <MenuDialogs open={dialog} onClose={() => setDialog(null)} onSaved={onChanged} />}
    </div>
  )
}
