'use client'

// A reply waiting on the person: who wrote, the application it is about with its role title at the company's
// weight, Cello's read of what it is, the first 6 lines, then Read all (fetched from Gmail when opened), Write my
// own reply, Open in Gmail and I have handled this. Nothing here sends: the person writes the reply.

import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { LogoTile, RoleTitle } from '@/components/roles/role-tile'
import { ago } from '@/lib/network/format'
import type { ReplyRow as Reply } from '@/lib/network/conversations'

const KIND_READ: Record<string, string> = { interview: 'An interview', offer: 'An offer', rejection: 'A decision', recruiter: 'A recruiter', reply: 'A reply' }

export function ReplyRow({ r, onHandled, onPerson }: { r: Reply; onHandled: (id: string) => void; onPerson: (r: Reply) => void }) {
  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function readAll() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/conversations/${r.id}/body`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not read it.')
      setBody(data.text as string)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read it.')
    } finally {
      setBusy(false)
    }
  }

  const gmail = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(r.threadId)}`
  return (
    <li className="r-row flex flex-wrap items-start gap-x-3 gap-y-2 py-3">
      <LogoTile name={r.contact?.employer ?? r.from ?? 'Sender'} size={40} state="ring" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="r-name">
          {r.contact && r.contactId ? (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => onPerson(r)}>{r.from}</button>
          ) : (
            'Someone'
          )}
          <span className="r-body">{r.contact ? `, ${[r.contact.title, r.contact.employer].filter(Boolean).join(' at ')}` : ''}</span>
        </p>
        {r.role && <RoleTitle id={r.role.id} title={r.role.title} company={r.role.company} layout="inline" />}
        <p className="r-meta mt-1">Cello&apos;s read: {KIND_READ[r.kind] ?? 'A reply'}. {ago(r.sentAt)}.</p>
        <p className="r-name mt-1">{r.subject || 'No subject'}</p>
        <p className="r-body whitespace-pre-line">{body ?? r.excerpt}</p>
        {error && <p className="r-meta" role="alert">{error}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {body === null && <Key variant="raised" disabled={busy} onClick={readAll}>Read all</Key>}
          {/* ponytail: the reply is written in Gmail; a Cello compose box arrives with the Writer's reply type */}
          <Key asChild><a href={gmail} target="_blank" rel="noopener noreferrer">Write my own reply</a></Key>
          <Key asChild variant="raised"><a href={gmail} target="_blank" rel="noopener noreferrer">Open in Gmail</a></Key>
          <Key variant="ghost" onClick={() => onHandled(r.id)}>I have handled this</Key>
        </div>
      </div>
    </li>
  )
}
