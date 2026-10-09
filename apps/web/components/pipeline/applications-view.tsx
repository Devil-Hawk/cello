'use client'

// Applications (blueprint 4.8): where each application stands and who acts next. One list of applications, read
// as groups (List) or as stage columns (Board). Every row lands in exactly one group, by one function,
// groupOf (lib/pipeline/groups.ts), already applied by the server; a role that was only saved is not here.

import Link from 'next/link'
import { useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Key } from '@/components/ui/key'
import { LogoTile, RoleTitle } from '@/components/roles/role-tile'
import { recordHref } from '@/lib/routes/roles'
import { statusSentence } from '@/lib/pipeline/states'
import type { FoundItem } from '@/lib/applications/found'
import type { ApplicationGroup } from '@/lib/pipeline/types'
import { ago } from '@/lib/network/format'

// The board loads when it is first opened: drag and drop is not part of the page's first load.
const Board = dynamic(() => import('./board').then((m) => m.Board), { ssr: false })

export interface AppRow {
  id: string
  job_id: string
  stage: string
  state: string | null
  step: string | null
  needs_reason: string | null
  needs_detail: Record<string, unknown> | null
  applied_at: string | null
  last_event_at: string | null
  created_at: string
  source: string | null
  closed_reason: string | null
  cost_usd: number | null
  found_state: 'to_confirm' | 'confirmed' | null
  group: ApplicationGroup | null
  jobs: { title: string; url: string | null; companies: { name: string } | null } | null
}

export const GROUPS: { id: ApplicationGroup; label: string }[] = [
  { id: 'needs_you', label: 'Needs you' },
  { id: 'preparing', label: 'Cello is preparing' },
  { id: 'waiting', label: 'Waiting on the employer' },
  { id: 'interview', label: 'Interview and offer' },
  { id: 'closed', label: 'Closed' },
]

/** Why an application closed, in the person's words. */
export const CLOSED_LABEL: Record<string, string> = {
  rejected: 'Not selected',
  withdrew: 'You withdrew',
  no_reply: 'No reply',
  posting_closed: 'Posting closed',
  skipped: 'Skipped',
}

/** The board's columns. Closed ones share the last column; there are no ghost or discovered columns. */
export const COLUMNS: { id: string; label: string; stages: string[] }[] = [
  { id: 'applied', label: 'Applied', stages: ['applied'] },
  { id: 'screen', label: 'Screen', stages: ['screen'] },
  { id: 'interview', label: 'Interview', stages: ['interview'] },
  { id: 'offer', label: 'Offer', stages: ['offer', 'accepted'] },
  { id: 'closed', label: 'Closed', stages: ['rejected', 'withdrawn', 'ghosted'] },
]
export const MOVE_TO: { stage: string; label: string }[] = [
  { stage: 'applied', label: 'Applied' },
  { stage: 'screen', label: 'Screen' },
  { stage: 'interview', label: 'Interview' },
  { stage: 'offer', label: 'Offer' },
  { stage: 'accepted', label: 'Accepted' },
  { stage: 'rejected', label: 'Rejected' },
  { stage: 'withdrawn', label: 'Withdrawn' },
]

export function groupRows(rows: AppRow[]): Map<ApplicationGroup, AppRow[]> {
  const out = new Map<ApplicationGroup, AppRow[]>(GROUPS.map((g) => [g.id, []]))
  for (const r of rows) if (r.group) out.get(r.group)!.push(r)
  return out
}

export interface Filters {
  company: string
  stage: string
  closed: string
  source: string
  month: string
}
export const NO_FILTERS: Filters = { company: '', stage: '', closed: '', source: '', month: '' }

export function applyFilters(rows: AppRow[], f: Filters): AppRow[] {
  return rows.filter(
    (r) =>
      (!f.company || r.jobs?.companies?.name === f.company) &&
      (!f.stage || r.stage === f.stage) &&
      (!f.closed || r.closed_reason === f.closed) &&
      (!f.source || (r.source ?? 'other') === f.source) &&
      (!f.month || (r.applied_at ?? '').slice(0, 7) === f.month),
  )
}

export const company = (r: AppRow) => r.jobs?.companies?.name ?? ''
const SOURCE_LABEL: Record<string, string> = { gmail_sync: 'From your email', manual: 'Added by you', other: 'Other' }

function Row({ r }: { r: AppRow }) {
  const sentence = statusSentence({ state: r.state as never, step: r.step, needsReason: r.needs_reason as never, needsDetail: r.needs_detail }, company(r))
  const cost = r.cost_usd && r.cost_usd > 0 ? `$${r.cost_usd.toFixed(2)}` : null
  return (
    <li className="r-row flex flex-wrap items-start gap-x-3 gap-y-2 py-3">
      <LogoTile name={company(r) || 'Company'} size={40} state={r.group === 'closed' ? 'flat' : r.group === 'needs_you' ? 'ring' : 'default'} />
      <div className="min-w-0 flex-1 basis-56">
        <RoleTitle id={r.job_id} title={r.jobs?.title ?? 'A role'} company={company(r)} />
        <p className="r-meta mt-1">
          {[sentence || (r.closed_reason ? CLOSED_LABEL[r.closed_reason] : null) || (r.stage === 'applied' ? 'Applied.' : null), r.last_event_at ? `Last activity ${ago(r.last_event_at)}` : null, cost].filter((x): x is string => Boolean(x)).map((x) => x.replace(/\.+$/, '')).join('. ')}
        </p>
        {r.found_state === 'to_confirm' && <p className="r-meta">Found in your email. Confirm it is yours.</p>}
      </div>
      <Key asChild variant={r.group === 'needs_you' ? 'ink' : 'raised'}>
        <Link href={recordHref(r.job_id)} prefetch={false}>{r.group === 'needs_you' ? 'Open' : 'View'}</Link>
      </Key>
    </li>
  )
}

/** Cello found these in the person's email and is unsure they are theirs; nothing counts until they confirm. */
export function ConfirmFound({ found, onConfirm }: { found: FoundItem[]; onConfirm: (f: FoundItem) => void }) {
  if (found.length === 0) return null
  return (
    <section aria-labelledby="confirm-h" className="r-sheet px-4 py-2">
      <h2 id="confirm-h" className="r-title pt-2">Confirm these applications</h2>
      <p className="r-meta">Cello found these in your email and is unsure they are yours. Nothing counts until you confirm.</p>
      <ul className="divide-y divide-[var(--r-line)]">
        {found.map((f) => (
          <li key={f.applicationId ?? f.messageId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
            <LogoTile name={f.company || 'Company'} size={40} />
            <div className="min-w-0 flex-1 basis-56">
              <p className="r-name">{f.title ?? 'A role'}</p>
              <p className="r-name">{f.company || 'An employer'}</p>
              <p className="r-meta">Found in your email, {ago(f.at)}.</p>
            </div>
            <Key onClick={() => onConfirm(f)}>Confirm</Key>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ApplicationsView({ rows, onMove, mode = 'list', found = [], onConfirmFound }: { rows: AppRow[]; onMove: (id: string, stage: string) => void; mode?: 'list' | 'board'; found?: FoundItem[]; onConfirmFound?: (f: FoundItem) => void }) {
  const [view, setView] = useState<'list' | 'board'>(mode)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const apps = useMemo(() => rows.filter((r) => r.group), [rows])
  const shown = useMemo(() => applyFilters(apps, filters), [apps, filters])
  const grouped = useMemo(() => groupRows(shown), [shown])
  const companies = useMemo(() => [...new Set(apps.map(company).filter(Boolean))].sort(), [apps])
  const sources = useMemo(() => [...new Set(apps.map((r) => r.source ?? 'other'))], [apps])
  const months = useMemo(() => [...new Set(apps.map((r) => (r.applied_at ?? '').slice(0, 7)).filter(Boolean))].sort().reverse(), [apps])
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters({ ...filters, [k]: e.target.value })

  return (
    <div className="space-y-6">
      <ConfirmFound found={found} onConfirm={(f) => onConfirmFound?.(f)} />
      <div className="flex flex-wrap items-end gap-3">
        <nav aria-label="View" className="flex gap-2">
          <Key variant={view === 'list' ? 'ink' : 'raised'} aria-pressed={view === 'list'} onClick={() => setView('list')}>List</Key>
          <Key variant={view === 'board' ? 'ink' : 'raised'} aria-pressed={view === 'board'} onClick={() => setView('board')}>Board</Key>
        </nav>
        <details className="r-meta">
          <summary className="min-h-11 cursor-pointer leading-[44px]">Filters</summary>
          <div className="flex flex-wrap gap-3 py-2">
            <label>Company
              <select className="r-field ml-2 min-h-11" value={filters.company} onChange={set('company')}><option value="">Any</option>{companies.map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </label>
            <label>Stage
              <select className="r-field ml-2 min-h-11" value={filters.stage} onChange={set('stage')}><option value="">Any</option>{MOVE_TO.map((m) => <option key={m.stage} value={m.stage}>{m.label}</option>)}</select>
            </label>
            <label>Closed because
              <select className="r-field ml-2 min-h-11" value={filters.closed} onChange={set('closed')}><option value="">Any</option>{Object.entries(CLOSED_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
            <label>Source
              <select className="r-field ml-2 min-h-11" value={filters.source} onChange={set('source')}><option value="">Any</option>{sources.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s] ?? s}</option>)}</select>
            </label>
            <label>Applied in
              <select className="r-field ml-2 min-h-11" value={filters.month} onChange={set('month')}><option value="">Any month</option>{months.map((m) => <option key={m} value={m}>{m}</option>)}</select>
            </label>
          </div>
        </details>
      </div>

      {shown.length === 0 ? (
        <p className="r-body">No applications match. Clear a filter to see more.</p>
      ) : view === 'list' ? (
        GROUPS.map((g) => {
          const items = grouped.get(g.id) ?? []
          if (items.length === 0) return null
          const body = <ul className="divide-y divide-[var(--r-line)]">{items.map((r) => <Row key={r.id} r={r} />)}</ul>
          return g.id === 'closed' ? (
            <details key={g.id} className="r-sheet px-4 py-2">
              <summary className="r-title min-h-11 cursor-pointer leading-[44px]">{g.label} ({items.length})</summary>
              {body}
            </details>
          ) : (
            <section key={g.id} aria-labelledby={`g-${g.id}`} className="r-sheet px-4 py-2">
              <h2 id={`g-${g.id}`} className="r-title pt-2">{g.label}</h2>
              {body}
            </section>
          )
        })
      ) : (
        <Board rows={shown} onMove={onMove} />
      )}
    </div>
  )
}
