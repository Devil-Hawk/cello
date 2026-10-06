'use client'

// Network (blueprint 4.9a): who to follow up with now, then everyone, as a list, by company or on a map.
// Every number comes from contact_touch and messages by code; a row opens the person's page.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Key } from '@/components/ui/key'
import { LogoTile, RoleTitle } from '@/components/roles/role-tile'
import { ContactDialog } from '@/components/contacts/contact-dialog'
import { CsvImportDialog } from '@/components/contacts/csv-import'
import type { ContactFormValues, CsvContactRow } from '@/components/contacts/types'
import { callCommand } from '@/lib/network/client'
import { KIND_LABEL, lastInTouch, replyEvidence } from '@/lib/network/format'
import type { PersonRow } from '@/lib/network/people'
import type { DueNudge } from '@/lib/network/nudges'
import { RuleEditor } from './rule'
import { NetworkMap } from './map'

const DOOR = '/api/network'
const FOLLOW_UP_ROWS = 5

export interface NetworkViewProps {
  people: PersonRow[]
  total: number
  page: number
  pages: number
  due: DueNudge[]
  rule: { on: boolean; after_yours_bd: number; after_theirs_d: number }
  /** "Cello left out 214 senders: ..." or null. */
  leftOutSentence: string | null
  leftOut: { email: string; rule: string }[]
  /** Gmail has been read at least once. */
  gmailRead: boolean
  gmailConnected: boolean
  query: { view: 'list' | 'company' | 'map'; q: string; kind: string; address: string; waiting: boolean; quiet: boolean; hasApp: string; order: 'last' | 'closest' }
}

function href(q: NetworkViewProps['query'], patch: Partial<Record<string, string>> & { page?: number }): string {
  const p = new URLSearchParams()
  const merged: Record<string, string> = { view: q.view, q: q.q, kind: q.kind, address: q.address, waiting: q.waiting ? '1' : '', quiet: q.quiet ? '1' : '', app: q.hasApp, order: q.order, ...(patch as Record<string, string>) }
  for (const [k, v] of Object.entries(merged)) if (v && !(k === 'view' && v === 'list') && !(k === 'order' && v === 'last')) p.set(k, v)
  if (patch.page && patch.page > 1) p.set('page', String(patch.page))
  const s = p.toString()
  return `/network${s ? `?${s}` : ''}`
}

function employerLine(p: Pick<PersonRow, 'title' | 'employer' | 'agency' | 'addressKind' | 'kind'>): string {
  const role = p.title ?? (p.kind ? KIND_LABEL[p.kind] : null)
  const where = p.employer ?? (p.agency ? `Agency: ${p.agency}` : null)
  return [role, where].filter(Boolean).join(' at ').replace(' at Agency:', ', Agency:') || 'Employer not known'
}

function FollowUpRow({ d, onChange }: { d: DueNudge; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function rule(r: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      await callCommand(DOOR, 'network.set_rule', { contact_id: d.contactId, rule: r })
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Nothing changed.')
    } finally {
      setBusy(false)
    }
  }
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  return (
    <li className="r-row flex flex-wrap items-start gap-x-3 gap-y-2 py-3">
      <LogoTile name={d.employer ?? d.agency ?? d.name} size={40} />
      <div className="min-w-0 flex-1 basis-56">
        <p className="r-name">
          <Link href={`/network/${d.contactId}`} className="hover:underline">{d.name}</Link>
          <span className="r-body">, {employerLine({ title: d.title, employer: d.employer, agency: d.agency, addressKind: null, kind: null })}</span>
        </p>
        {d.tie?.roleId && <RoleTitle id={d.tie.roleId} title={d.tie.roleTitle} company={d.tie.company} layout="inline" />}
        <p className="r-meta mt-1">{d.fact}</p>
        {error && <p className="r-meta" role="alert">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Key asChild>
          <Link href={d.draftId ? `/conversations?draft=${d.draftId}` : `/network/${d.contactId}`}>Review follow-up</Link>
        </Key>
        <Key variant="raised" disabled={busy} onClick={() => rule({ snooze_until: week })}>Snooze</Key>
        <Key variant="ghost" disabled={busy} onClick={() => rule({ off: true })}>Not needed</Key>
      </div>
    </li>
  )
}

export function PersonLine({ p }: { p: PersonRow }) {
  const evidence = replyEvidence(p.sentN, p.receivedN)
  return (
    <li className="r-row flex flex-wrap items-start gap-x-3 gap-y-1 py-3">
      <LogoTile name={p.employer ?? p.agency ?? p.name} size={40} />
      <div className="min-w-0 flex-1 basis-56">
        <p className="r-name">
          <Link href={`/network/${p.id}`} className="hover:underline">{p.name}</Link>
        </p>
        <p className="r-body">{employerLine(p)}</p>
        {p.addressKind === 'personal' && <p className="r-meta">Personal address</p>}
        <p className="r-meta">
          {lastInTouch(p.lastAt, p.lastFrom)}
          {evidence ? `. ${evidence}` : ''}
        </p>
        {p.ties.filter((t) => t.roleId).map((t) => (
          <RoleTitle key={t.applicationId} id={t.roleId as string} title={t.roleTitle} company={t.company} layout="inline" />
        ))}
      </div>
      <details className="r-meta">
        <summary className="min-h-11 cursor-pointer leading-[44px]">{p.band}</summary>
        {p.bandWhy}
      </details>
      {p.waitingOn === 'you' && <span className="r-meta" role="img" aria-label="Waiting on you">Waiting on you</span>}
    </li>
  )
}

export function NetworkView(props: NetworkViewProps) {
  const router = useRouter()
  const { people, due, query } = props
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [rules, setRules] = useState(false)
  const [showLeft, setShowLeft] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const refresh = () => router.refresh()

  async function run(command: string, input: Record<string, unknown>, done: string) {
    setNote(null)
    try {
      await callCommand(DOOR, command, input)
      setNote(done)
      refresh()
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not do that. Nothing changed.')
    }
  }

  const empty = props.total === 0 && !query.q && !query.kind && !query.address && !query.waiting && !query.quiet && !query.hasApp
  const groups = new Map<string, PersonRow[]>()
  for (const p of people) {
    const k = p.employer ?? (p.agency ? `Agency: ${p.agency}` : 'Employer not known')
    groups.set(k, [...(groups.get(k) ?? []), p])
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-10 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="r-display">Network</h1>
        <div className="flex flex-wrap gap-2">
          <Key variant="raised" onClick={() => setAdding(true)}>Add a person</Key>
          <Key variant="raised" onClick={() => setImporting(true)}>Import contacts (CSV)</Key>
          <Key variant="ghost" aria-expanded={rules} onClick={() => setRules(!rules)}>Follow-up reminders</Key>
        </div>
      </header>
      {note && <p className="r-meta -mt-6" role="status">{note}</p>}

      {rules && (
        <section className="r-sheet p-6" aria-label="Follow-up reminders">
          <h2 className="r-title mb-3">Follow-up reminders</h2>
          <RuleEditor global={props.rule} onSaved={refresh} />
        </section>
      )}

      {empty ? (
        <section className="r-sheet space-y-3 p-6">
          {!props.gmailConnected ? (
            <>
              <p className="r-body">Cello builds your network from your email. Connect Gmail, import a CSV, or add a person. Cello reads job mail, and the headers of your threads with people at employers&apos; own addresses. It never sends without your click.</p>
              <div className="flex flex-wrap gap-2">
                <Key asChild><Link href="/settings?tab=connections">Connect Gmail</Link></Key>
                <Key variant="raised" onClick={() => setImporting(true)}>Import contacts (CSV)</Key>
                <Key variant="raised" onClick={() => setAdding(true)}>Add a person</Key>
              </div>
            </>
          ) : (
            <p className="r-body">{props.gmailRead ? 'Nobody from your mail yet. Import a CSV or add a person.' : 'Looking for people in your mail. The first names arrive in a few minutes.'}</p>
          )}
        </section>
      ) : (
        <>
          <section aria-labelledby="fu-heading" className="space-y-2">
            <h2 id="fu-heading" className="r-title">Follow up</h2>
            {due.length === 0 ? (
              <p className="r-body">Nobody is waiting on you.</p>
            ) : (
              <ul className="r-sheet divide-y divide-[var(--r-line)] px-4">
                {due.slice(0, FOLLOW_UP_ROWS).map((d) => (
                  <FollowUpRow key={d.contactId} d={d} onChange={refresh} />
                ))}
              </ul>
            )}
            {due.length > FOLLOW_UP_ROWS && <p className="r-meta">{due.length - FOLLOW_UP_ROWS} more are due. Open Everyone and filter by Waiting on you.</p>}
          </section>

          <section aria-labelledby="all-heading" className="space-y-3">
            <h2 id="all-heading" className="r-title">Everyone</h2>
            <form action="/network" method="get" className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 basis-56">
                <span className="sr-only">Search by name, employer or kind</span>
                <input name="q" defaultValue={query.q} placeholder="Search by name, employer or kind" className="r-field min-h-11 w-full" />
              </label>
              {query.view !== 'list' && <input type="hidden" name="view" value={query.view} />}
              <Key type="submit">Search</Key>
            </form>
            <details className="r-meta">
              <summary className="min-h-11 cursor-pointer leading-[44px]">Filters</summary>
              <form action="/network" method="get" className="flex flex-wrap items-end gap-3 py-2">
                {query.q && <input type="hidden" name="q" value={query.q} />}
                {query.view !== 'list' && <input type="hidden" name="view" value={query.view} />}
                <label>Kind
                  <select name="kind" defaultValue={query.kind} className="r-field ml-2 min-h-11">
                    <option value="">Any</option>
                    {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
                <label>Address
                  <select name="address" defaultValue={query.address} className="r-field ml-2 min-h-11">
                    <option value="">Any</option>
                    <option value="employer">Employer</option>
                    <option value="personal">Personal</option>
                  </select>
                </label>
                <label>Has an application
                  <select name="app" defaultValue={query.hasApp} className="r-field ml-2 min-h-11">
                    <option value="">Any</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>
                <label className="flex min-h-11 items-center gap-2"><input type="checkbox" name="waiting" value="1" defaultChecked={query.waiting} /> Waiting on you</label>
                <label className="flex min-h-11 items-center gap-2"><input type="checkbox" name="quiet" value="1" defaultChecked={query.quiet} /> Quiet</label>
                <label>Order
                  <select name="order" defaultValue={query.order} className="r-field ml-2 min-h-11">
                    <option value="last">Last in touch</option>
                    <option value="closest">Closest first</option>
                  </select>
                </label>
                <Key type="submit" variant="raised">Apply</Key>
              </form>
            </details>
            <nav aria-label="Views" className="flex gap-2">
              {(['list', 'company', 'map'] as const).map((v) => (
                <Key key={v} asChild variant={query.view === v ? 'ink' : 'raised'} current={query.view === v}>
                  <Link href={href(query, { view: v })}>{v === 'list' ? 'List' : v === 'company' ? 'By company' : 'Map'}</Link>
                </Key>
              ))}
            </nav>
            {people.length === 0 ? (
              <p className="r-body">No one matches. Clear a filter to see more.</p>
            ) : query.view === 'map' ? (
              <NetworkMap people={people} />
            ) : query.view === 'company' ? (
              [...groups].map(([name, ps]) => (
                <div key={name} className="r-sheet px-4 py-2">
                  <h3 className="r-name pt-2">{name}</h3>
                  <ul className="divide-y divide-[var(--r-line)]">{ps.map((p) => <PersonLine key={p.id} p={p} />)}</ul>
                </div>
              ))
            ) : (
              <ul className="r-sheet divide-y divide-[var(--r-line)] px-4">{people.map((p) => <PersonLine key={p.id} p={p} />)}</ul>
            )}
            {props.pages > 1 && (
              <nav aria-label="Pages" className="flex items-center gap-3">
                {props.page > 1 && <Key asChild variant="raised"><Link href={href(query, { page: props.page - 1 })}>Previous</Link></Key>}
                <span className="r-meta">Page {props.page} of {props.pages}</span>
                {props.page < props.pages && <Key asChild variant="raised"><Link href={href(query, { page: props.page + 1 })}>Next</Link></Key>}
              </nav>
            )}
          </section>

          {props.leftOutSentence && (
            <section aria-label="Left out" className="space-y-2">
              <p className="r-body">
                {props.leftOutSentence}{' '}
                <button type="button" className="underline" onClick={() => setShowLeft(!showLeft)} aria-expanded={showLeft}>{showLeft ? 'Hide them' : 'Show them'}</button>
              </p>
              {showLeft && (
                <ul className="r-sheet divide-y divide-[var(--r-line)] px-4">
                  {props.leftOut.map((l) => (
                    <li key={l.email} className="flex flex-wrap items-center gap-2 py-2">
                      <span className="r-body min-w-0 flex-1 break-all">{l.email}</span>
                      <span className="r-meta">{l.rule.replace('_', ' ')}</span>
                      <Key variant="raised" onClick={() => run('people.add', { name: l.email.split('@')[0].replace(/[._-]+/g, ' '), email: l.email }, 'Added.')}>Add</Key>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      <ContactDialog
        open={adding}
        onOpenChange={setAdding}
        contact={null}
        companies={[]}
        isSaving={false}
        onSubmit={(v: ContactFormValues) => {
          setAdding(false)
          void run('people.add', { name: v.name, ...(v.email ? { email: v.email } : {}), ...(v.title ? { title: v.title } : {}), ...(v.relationship ? { relationship: v.relationship } : {}), ...(v.notes ? { notes: v.notes } : {}), ...(v.linkedinUrl ? { linkedin_url: v.linkedinUrl } : {}) }, 'Added.')
        }}
      />
      <CsvImportDialog
        open={importing}
        onOpenChange={setImporting}
        isImporting={false}
        onImport={(rows: CsvContactRow[]) => {
          setImporting(false)
          void run('people.import', { rows: rows.map((r) => ({ name: r.name, ...(r.email ? { email: r.email.toLowerCase() } : {}), ...(r.title ? { title: r.title } : {}), ...(r.linkedin_url ? { linkedin_url: r.linkedin_url } : {}) })) }, 'Imported.')
        }}
      />
    </div>
  )
}
