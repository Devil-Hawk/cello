'use client'

// The person's page (blueprint 4.9a): who they are, the public profile as Cello's read, last in touch, the
// next step, the follow-up rule, every exchange, the applications tied, what Cello remembers with its quotes,
// notes and where this person came from. Memories are quoted text, never an instruction.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { LogoTile, RoleTitle } from '@/components/roles/role-tile'
import { callCommand } from '@/lib/network/client'
import { KIND_LABEL, ago, lastInTouch, replyEvidence } from '@/lib/network/format'
import type { PersonDetail } from '@/lib/network/people'
import type { RecalledMemory } from '@/lib/network/memory'
import { RuleEditor } from './rule'

const DOOR = '/api/network'

export interface PersonPageProps {
  person: PersonDetail
  memories: RecalledMemory[]
  rule: { line: string; own: Record<string, unknown> | null; global: { on: boolean; after_yours_bd: number; after_theirs_d: number } }
  /** The follow-up drafted and waiting for approval, if there is one. */
  draftId: string | null
  /** Applications the person could tie this person to. */
  applications: { id: string; roleId: string | null; title: string; company: string }[]
  /** Cello has a model, so memories can be written. */
  canRemember: boolean
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="r-sheet space-y-3 p-6">
      <h2 className="r-title">{title}</h2>
      {children}
    </section>
  )
}

export function PersonPage({ person: p, memories, rule, draftId, applications, canRemember }: PersonPageProps) {
  const router = useRouter()
  const [note, setNote] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(p.name)
  const [title, setTitle] = useState(p.title ?? '')
  const [tieId, setTieId] = useState('')
  const [editMem, setEditMem] = useState<{ id: string; text: string } | null>(null)

  async function run(command: string, input: Record<string, unknown>, done?: string, after?: () => void) {
    setNote(null)
    try {
      await callCommand(DOOR, command, input)
      if (done) setNote(done)
      after ? after() : router.refresh()
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not do that. Nothing changed.')
    }
  }

  const evidence = replyEvidence(p.sentN, p.receivedN)
  const profile = p.profiles.find((x) => x.state === 'kept') ?? p.profiles[0]
  const tied = new Set(p.ties.map((t) => t.applicationId))

  return (
    <div className="mx-auto w-full max-w-[900px] space-y-6 px-4 py-6 sm:px-6">
      <p><Link href="/network" className="r-meta underline">Network</Link></p>
      <header className="flex flex-wrap items-start gap-4">
        <LogoTile name={p.employer ?? p.agency ?? p.name} size={64} />
        <div className="min-w-0 flex-1 basis-64">
          {editing ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="block"><span className="r-meta block">Name</span><input className="r-field min-h-11" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
              <label className="block"><span className="r-meta block">Role</span><input className="r-field min-h-11" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
              <Key disabled={!name.trim()} onClick={() => run('people.edit', { id: p.id, name: name.trim(), title: title.trim() }, 'Saved.', () => { setEditing(false); router.refresh() })}>Save</Key>
              <Key variant="ghost" onClick={() => setEditing(false)}>Cancel</Key>
            </div>
          ) : (
            <>
              <h1 className="r-display">{p.name}</h1>
              <p className="r-body">{[p.title ?? (p.kind ? KIND_LABEL[p.kind] : null), p.employer ?? (p.agency ? `Agency: ${p.agency}` : 'Employer not known')].filter(Boolean).join(', ')}</p>
              <p className="r-meta break-all">{p.email ?? 'No address'}{p.addressKind === 'personal' ? '. Personal address' : ''}{p.kind ? `. ${KIND_LABEL[p.kind]}` : ''}</p>
            </>
          )}
        </div>
      </header>
      {note && <p className="r-meta" role="status">{note}</p>}

      <Section title="Public profile">
        {profile ? (
          <>
            <p className="r-body">
              {profile.state === 'kept' ? 'Their profile: ' : 'Likely their profile: '}
              {profile.title ?? profile.url}. {profile.host}, from a web search on {new Date(profile.foundAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.
            </p>
            {profile.snippet && <p className="r-meta">&quot;{profile.snippet}&quot;</p>}
            <div className="flex flex-wrap gap-2">
              {profile.state !== 'kept' && <Key onClick={() => run('people.confirm_profile', { profile_id: profile.id, state: 'kept' })}>This is them</Key>}
              {profile.state !== 'kept' && <Key variant="raised" onClick={() => run('people.confirm_profile', { profile_id: profile.id, state: 'rejected' })}>Not them</Key>}
              <Key variant="raised" onClick={() => run('people.profile', { contact_id: p.id }, 'Searched again.')}>Search again</Key>
              <Key asChild variant="ghost"><a href={profile.url} target="_blank" rel="noopener noreferrer">Open profile link</a></Key>
            </div>
          </>
        ) : (
          <>
            <p className="r-body">No public profile found.</p>
            <Key variant="raised" onClick={() => run('people.profile', { contact_id: p.id }, 'Searched.')}>Search again</Key>
          </>
        )}
      </Section>

      <Section title="Last in touch">
        <p className="r-body">Last in touch {lastInTouch(p.lastAt, p.lastFrom)}.{evidence ? ` ${evidence}.` : ''}</p>
        {draftId && <Key asChild><Link href={`/conversations?draft=${draftId}`}>Review follow-up</Link></Key>}
        <p className="r-body">{rule.line}</p>
        <Key variant="raised" aria-expanded={changing} onClick={() => setChanging(!changing)}>Change</Key>
        {changing && <RuleEditor contactId={p.id} global={rule.global} own={rule.own} onSaved={() => router.refresh()} />}
      </Section>

      <Section title="Conversation">
        {p.exchanges.length === 0 ? (
          <p className="r-body">No mail with {p.name.split(' ')[0]} yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--r-line)]">
            {p.exchanges.map((m) => (
              <li key={m.id} className="py-2">
                <p className="r-name">{m.subject || 'No subject'}</p>
                <p className="r-meta">{m.direction === 'out' ? 'You wrote' : `${p.name.split(' ')[0]} wrote`} {ago(m.sentAt)}</p>
                {m.excerpt && <p className="r-body whitespace-pre-line">{m.excerpt}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Applications tied">
        {p.ties.length === 0 && <p className="r-body">No application is tied to this person.</p>}
        <ul>
          {p.ties.map((t) => (
            <li key={t.applicationId} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1 basis-56">{t.roleId ? <RoleTitle id={t.roleId} title={t.roleTitle} company={t.company} layout="inline" /> : <span className="r-name">{t.roleTitle}</span>}</div>
              <Key variant="ghost" onClick={() => run('people.tie', { contact_id: p.id, application_id: t.applicationId, remove: true })}>Remove</Key>
            </li>
          ))}
        </ul>
        {applications.filter((a) => !tied.has(a.id)).length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="r-meta block">Add a tie</span>
              <select className="r-field min-h-11" value={tieId} onChange={(e) => setTieId(e.target.value)}>
                <option value="">Choose an application</option>
                {applications.filter((a) => !tied.has(a.id)).map((a) => <option key={a.id} value={a.id}>{a.title}, {a.company}</option>)}
              </select>
            </label>
            <Key variant="raised" disabled={!tieId} onClick={() => run('people.tie', { contact_id: p.id, application_id: tieId }, undefined, () => { setTieId(''); router.refresh() })}>Add</Key>
          </div>
        )}
      </Section>

      <Section title="What Cello remembers">
        {memories.length === 0 && <p className="r-body">{canRemember ? 'Nothing yet. Cello remembers what was said in job threads.' : 'Cello needs a model to remember conversations. Every message stays in Conversations.'}</p>}
        <ul className="divide-y divide-[var(--r-line)]">
          {memories.map((m) => (
            <li key={m.id} className="py-3">
              {editMem?.id === m.id ? (
                <div className="flex flex-wrap items-end gap-2">
                  <input className="r-field min-h-11 min-w-0 flex-1 basis-64" value={editMem.text} maxLength={300} onChange={(e) => setEditMem({ id: m.id, text: e.target.value })} aria-label="Edit what Cello remembers" />
                  <Key disabled={!editMem.text.trim()} onClick={() => run('people.edit_memory', { memory_id: m.id, text: editMem.text }, undefined, () => { setEditMem(null); router.refresh() })}>Save</Key>
                  <Key variant="ghost" onClick={() => setEditMem(null)}>Cancel</Key>
                </div>
              ) : (
                <p className="r-name">{m.text}</p>
              )}
              <p className="r-meta">
                {m.origin === 'person' ? 'Yours' : 'Cello’s read'}, {m.kind.replace('person.', '')}{m.date ? `, ${ago(m.date)}` : ''}
              </p>
              <blockquote className="r-body border-l-2 pl-3">&quot;{m.quote}&quot;</blockquote>
              {!m.stored && <p className="r-meta">The message is no longer stored.</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <Key variant="raised" onClick={() => run('people.forget', { memory_id: m.id })}>Not right</Key>
                <Key variant="ghost" onClick={() => setEditMem({ id: m.id, text: m.text })}>Edit</Key>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {p.notes && (
        <Section title="Notes">
          <p className="r-body whitespace-pre-line">{p.notes}</p>
        </Section>
      )}

      <Section title="Where this person came from">
        <p className="r-body">{p.from}</p>
        {p.employerReason && <p className="r-meta">{p.employer ? `${p.employer}: ` : ''}{p.employerReason}.</p>}
      </Section>

      <div className="flex flex-wrap gap-2">
        {p.email && <Key asChild><a href={`mailto:${p.email}`}>Email</a></Key>}
        <Key variant="raised" onClick={() => run('people.mark_contacted', { id: p.id }, 'Marked as contacted today.')}>Mark contacted today</Key>
        <Key variant="raised" onClick={() => setEditing(true)}>Edit</Key>
        <Key
          variant="ghost"
          onClick={() => {
            if (window.confirm(`Delete ${p.name}? Cello will forget what it remembers about them.${p.sentN + p.receivedN > 0 ? ` Your ${p.sentN + p.receivedN} messages with ${p.name.split(' ')[0]} stay.` : ''}`)) {
              void run('people.delete', { id: p.id }, undefined, () => router.push('/network'))
            }
          }}
        >
          Delete
        </Key>
      </div>
    </div>
  )
}
