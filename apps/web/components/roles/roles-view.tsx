'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'
import { Key } from '@/components/ui/key'
import { companyHref } from '@/lib/routes/companies'
import { companies, search } from '@/lib/routes'
import {
  GROUPS,
  GROUP_LABEL,
  PAGE,
  TABS,
  TAB_LABEL,
  bandOf,
  filterCount,
  groupByCompany,
  groupCountLine,
  metaLine,
  orderItems,
  outsideLine,
  rolesHref,
  type EmployerFacts,
  type RolesQuery,
} from './logic'
import { Filters } from './filters'
import { NOT_FOR_ME_REASONS, deleteReaction, visibleItems } from './reactions'
import { RoleLine } from './role-line'
import { RoleRow } from './role-row'
import { LogoTile } from './role-tile'
import type { PickItem, RoleItem } from './types'
import { useReactionState } from './use-reaction-state'

export interface RolesViewProps {
  query: RolesQuery
  /** The rows of the current window, as read: not yet ordered. */
  items: RoleItem[]
  /** Today's picks, when picks are on and built. */
  picks: PickItem[]
  /** Roles under the filters, counted in SQL. */
  total: number
  /** Roles that became visible to the person today, counted in SQL. */
  newToday: number
  /** role_counts('employer'): the person's roles at each employer. */
  groupCounts: Record<string, number>
  /** The last read's open total and the reason an employer cannot be read, by employer. */
  facts: Record<string, EmployerFacts>
  /** role_counts('outside_week'): left outside the search this week, by reason. */
  outside: Record<string, number>
  /** The check line from the clock ("Checked 3 hours ago."), when it is known. */
  checkLine?: string | null
  /** The list could not be read. */
  failed?: boolean
}

// The add dialog and the browser client load when they are used, not with the page.
const AddCompanyDialog = dynamic(() => import('@/components/companies/add-company-dialog').then((m) => m.AddCompanyDialog), { ssr: false })

const reasonLabel = (r: string | null | undefined) => NOT_FOR_ME_REASONS.find((x) => x.reason === r)?.label ?? null

// Roles: every role kept for the person, today's picks first, in the order of
// their address. The reactions live here, above the rows, so a regroup, a filter
// or a page of more rows never loses an Undo that is still open.
export function RolesView({ query, items, picks, total, newToday, groupCounts, facts, outside, checkLine, failed }: RolesViewProps) {
  const router = useRouter()
  const { state, dispatch, now } = useReactionState()
  const [pasting, setPasting] = useState(false)

  const line = (item: RoleItem, extra?: { pickKind?: 'top' | 'explore'; sentence?: string }) => (
    <RoleLine key={item.id} item={item} state={state} dispatch={dispatch} now={now} pickKind={extra?.pickKind} sentence={extra?.sentence} />
  )

  const visible = visibleItems(items, state, now)
  const filtered = filterCount(query) > 0
  const ordered = orderItems(visible, query.sort)
  const band = bandOf(visible, picks)
  const showBand = query.tab === 'for-you' && query.group === 'ranked' && query.sort === 'ranked' && !filtered && band.items.length > 0 && (band.kind === 'picks' || newToday > 0)
  const bandIds = new Set(showBand ? band.items.map((i) => i.id) : [])
  // The page holds `limit` rows in all: the band counts toward them, so 26 roles show 25 and Show more.
  const rest = ordered.filter((i) => !bandIds.has(i.id)).slice(0, Math.max(0, query.limit - bandIds.size))
  const shown = rest.length + bandIds.size
  const groups = groupByCompany(ordered, groupCounts, facts)
  const outsideText = query.tab === 'for-you' ? outsideLine(outside) : null

  async function removeSaved(id: string) {
    // The generated types predate person_roles.saved_at.
    const { createClient } = await import('@/lib/supabase/client')
    await (createClient() as unknown as SupabaseClient).from('person_roles').update({ saved_at: null }).eq('job_id', id)
    router.refresh()
  }

  async function putBack(id: string) {
    if (await deleteReaction(id)) router.refresh()
  }

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 pb-16">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="r-display">Roles</h1>
        <Key variant="raised" onClick={() => setPasting(true)}>
          Paste a link
        </Key>
      </header>
      {pasting && <AddCompanyDialog open onOpenChange={setPasting} onAdded={() => router.refresh()} />}

      {query.tab === 'for-you' && (
        <p className="r-meta">
          {query.group === 'company' ? 'Grouped by company.' : query.sort === 'newest' ? 'Newest first.' : 'Ranked for you.'}
          {checkLine ? ` ${checkLine}` : ''}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <nav aria-label="Roles" className="flex gap-1">
          {TABS.map((t) => (
            <Key key={t} asChild variant="ghost" current={query.tab === t}>
              <Link href={rolesHref(query, { tab: t, limit: PAGE })}>{TAB_LABEL[t]}</Link>
            </Key>
          ))}
        </nav>
        {query.tab === 'for-you' && (
          <>
            <nav aria-label="Group by" className="flex items-center gap-1">
              <span className="r-meta mr-1">Group by</span>
              {GROUPS.map((g) => (
                <Key key={g} asChild variant="ghost" current={query.group === g}>
                  <Link href={rolesHref(query, { group: g, limit: PAGE })}>{GROUP_LABEL[g]}</Link>
                </Key>
              ))}
            </nav>
            <nav aria-label="Sort" className="flex items-center gap-1">
              <span className="r-meta mr-1">Sort</span>
              {(['ranked', 'newest'] as const).map((o) => (
                <Key key={o} asChild variant="ghost" current={query.sort === o}>
                  <Link href={rolesHref(query, { sort: o, limit: PAGE })}>{o === 'ranked' ? 'Ranked' : 'Newest'}</Link>
                </Key>
              ))}
            </nav>
            <Filters query={query} />
          </>
        )}
      </div>

      {failed && (
        <p role="alert" className="r-body">
          Could not load roles. <Link href={rolesHref(query)} className="underline underline-offset-4">Try again</Link>
        </p>
      )}

      {!failed && query.tab === 'for-you' && ordered.length === 0 && (
        <div className="space-y-4">
          <p className="r-body">{filtered ? 'No kept role matches these filters.' : 'Nothing new fits your search yet.'}</p>
          <div className="flex flex-wrap gap-3">
            {filtered ? (
              <Key asChild variant="raised">
                <Link href={rolesHref(query, { level: null, posted: 'any', remote: false, country: null, company: null, hideAgency: false })}>Clear filters</Link>
              </Key>
            ) : (
              <>
                <Key asChild variant="raised">
                  <Link href={search.href}>Edit your search</Link>
                </Key>
                <Key asChild variant="raised">
                  <Link href={companies.href}>Follow an employer</Link>
                </Key>
              </>
            )}
          </div>
        </div>
      )}

      {showBand && (
        <section aria-labelledby="band" className="space-y-2">
          <h2 id="band" className="r-title">
            {band.kind === 'picks' ? "Today's picks" : 'Newest roles'}, {band.items.length}
            {newToday > 0 ? ` of ${newToday} new` : ''}
          </h2>
          <div className="r-sheet-lead">
            {band.items.map((i) => line(i, { pickKind: (i as PickItem).kind, sentence: (i as PickItem).explanation }))}
          </div>
        </section>
      )}

      {!failed && query.tab === 'for-you' && query.group === 'ranked' && rest.length > 0 && <div className="r-sheet">{rest.map((i) => line(i))}</div>}

      {!failed && query.tab === 'for-you' && query.group === 'company' && (
        <div className="space-y-8">
          {groups.map((g) => {
            const countLine = groupCountLine(g)
            return (
              <section key={g.key} aria-label={g.company} className="space-y-1">
                <div className="flex items-center gap-3 px-2">
                  <LogoTile name={g.company} domain={g.domain} logoUrl={g.logoUrl} companyId={g.companyId} size={40} />
                  <div className="min-w-0">
                    {g.companyId ? (
                      <Link href={companyHref(g.companyId)} className="r-name hover:underline">
                        {g.company}
                      </Link>
                    ) : (
                      <span className="r-name">{g.company}</span>
                    )}
                    {countLine && <p className="r-meta">{countLine}</p>}
                  </div>
                </div>
                <div className="r-sheet">{g.items.map((i) => line(i))}</div>
                {g.more !== null && g.more > 0 && g.companyId && (
                  <p className="px-2">
                    <Link href={rolesHref(query, { group: 'ranked', company: g.companyId, limit: PAGE })} className="r-body underline underline-offset-4">
                      {g.more} more at {g.company}
                    </Link>
                  </p>
                )}
              </section>
            )
          })}
        </div>
      )}

      {query.tab === 'for-you' && query.group === 'ranked' && total > shown && (
        <Key asChild variant="raised">
          <Link href={rolesHref(query, { limit: query.limit + PAGE })}>Show more</Link>
        </Key>
      )}

      {query.tab === 'saved' && (
        <div className="space-y-3">
          {ordered.length === 0 ? (
            <p className="r-body">Nothing saved yet. Interested saves a role here.</p>
          ) : (
            <div className="r-sheet">
              {ordered.map((i) =>
                i.closed ? (
                  <RoleRow
                    key={i.id}
                    id={i.id}
                    title={i.title}
                    company={i.company}
                    companyId={i.companyId}
                    domain={i.domain}
                    logoUrl={i.logoUrl}
                    state="flat"
                    meta="Closed. You saved this."
                    actions={
                      <Key variant="raised" onClick={() => removeSaved(i.id)}>
                        Remove
                      </Key>
                    }
                  />
                ) : (
                  line(i)
                ),
              )}
            </div>
          )}
        </div>
      )}

      {query.tab === 'hidden' && (
        <div className="space-y-3">
          {ordered.length === 0 ? (
            <p className="r-body">Nothing hidden.</p>
          ) : (
            <div className="r-sheet">
              {ordered.map((i) => (
                <RoleRow
                  key={i.id}
                  id={i.id}
                  title={i.title}
                  company={i.company}
                  companyId={i.companyId}
                  domain={i.domain}
                  logoUrl={i.logoUrl}
                  meta={[i.hiddenReason === 'not_for_me' ? `Not for me${reasonLabel(i.reaction?.reason) ? `: ${reasonLabel(i.reaction?.reason)}` : ''}` : null, metaLine(i, now)].filter(Boolean).join(' · ')}
                  actions={
                    i.hiddenReason === 'not_for_me' ? (
                      <Key variant="raised" onClick={() => putBack(i.id)}>
                        Undo
                      </Key>
                    ) : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}

      {outsideText && (
        <p className="r-body text-r-ink-2">
          {outsideText}{' '}
          <Link href={search.href} className="underline underline-offset-4">
            Edit your search
          </Link>
        </p>
      )}
    </div>
  )
}
