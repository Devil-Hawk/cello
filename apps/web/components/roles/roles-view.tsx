'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'
import { Key } from '@/components/ui/key'
import { OpenRouterDoor } from '@/components/settings/openrouter-door'
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
  groupByType,
  groupCountLine,
  metaLine,
  NO_FILTERS,
  NO_MODEL_LINE,
  orderItems,
  outsideLine,
  rolesHref,
  typeGroupHeader,
  uncheckedLine,
  type EmployerFacts,
  type RolesQuery,
} from './logic'
import { CheckAllMenu } from './check-all'
import { Filters } from './filters'
import { NOT_FOR_ME_REASONS, deleteReaction, visibleItems } from './reactions'
import { ChangeType } from './change-type'
import { RoleLine, type TypeControls } from './role-line'
import { applyTypeChanges } from './type-change'
import { useTypeChanges } from './use-type-changes'
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
  /** role_counts('role_type'): the person's roles of each type, by the type they see. */
  typeCounts: Record<string, number>
  /** Every type Change type and the Role type filter offer, by label. */
  typeOptions: { id: string; label: string }[]
  /** The employers the Company chooser offers (those with roles for the person), by name. */
  companyOptions: { id: string; label: string }[]
  /** The person needs sponsorship, so Past H-1B filings is offered. */
  needsSponsorship: boolean
  /** Roles Cello could not place, counted in SQL. */
  untypedTotal: number
  /** The last read's open total and the reason an employer cannot be read, by employer. */
  facts: Record<string, EmployerFacts>
  /** role_counts('outside_week'): left outside the search this week, by reason. */
  outside: Record<string, number>
  /** The check line from the clock ("Checked 3 hours ago."), when it is known. */
  checkLine?: string | null
  /** The list could not be read. */
  failed?: boolean
  /** Kept roles Cello has not checked yet, counted in SQL. */
  unchecked?: number
  /** The first of them, for Check chances for all. */
  uncheckedIds?: string[]
  /** A model can run for the person (a key of theirs or a free one). */
  hasModel?: boolean
  /** The person has reacted to at least one role. */
  reacted?: boolean
}

// The add dialog and the browser client load when they are used, not with the page.
const AddCompanyDialog = dynamic(() => import('@/components/companies/add-company-dialog').then((m) => m.AddCompanyDialog), { ssr: false })

const reasonLabel = (r: string | null | undefined) => NOT_FOR_ME_REASONS.find((x) => x.reason === r)?.label ?? null

// Roles: every role kept for the person, today's picks first, in the order of
// their address. The reactions live here, above the rows, so a regroup, a filter
// or a page of more rows never loses an Undo that is still open.
export function RolesView({ query, items: read, picks, total, newToday, groupCounts, typeCounts, typeOptions, companyOptions, needsSponsorship, untypedTotal, facts, outside, checkLine, failed, unchecked = 0, uncheckedIds = [], hasModel = true, reacted = true }: RolesViewProps) {
  const router = useRouter()
  const { state, dispatch, now } = useReactionState()
  const [pasting, setPasting] = useState(false)
  const typed = useTypeChanges()
  // A role whose type the person changed is drawn under its new type at once; the server has it already.
  const items = applyTypeChanges(read, typed.changes)
  const types: TypeControls = { options: typeOptions, now: typed.now, changes: typed.changes, onChange: typed.set, onUndo: typed.clear, onReset: () => router.refresh() }

  const line = (item: RoleItem, extra?: { pickKind?: 'top' | 'explore'; sentence?: string }) => (
    <RoleLine key={item.id} item={item} state={state} dispatch={dispatch} now={now} pickKind={extra?.pickKind} sentence={extra?.sentence} types={types} />
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
  const typeGroups = groupByType(ordered, typeCounts)
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
        <div className="flex items-center gap-2">
          <Key variant="raised" onClick={() => setPasting(true)}>
            Paste a link
          </Key>
          {query.tab === 'for-you' && hasModel && <CheckAllMenu ids={uncheckedIds} />}
        </div>
      </header>
      {pasting && <AddCompanyDialog open onOpenChange={setPasting} onAdded={() => router.refresh()} />}

      {query.tab === 'for-you' && (
        <p className="r-meta">
          {query.group === 'company' ? 'Grouped by company.' : query.group === 'type' ? 'Grouped by role type.' : query.sort === 'newest' ? 'Newest first.' : 'Ranked for you.'}
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
            <Filters query={query} typeOptions={typeOptions} companyOptions={companyOptions} needsSponsorship={needsSponsorship} />
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
          {!filtered && checkLine && <p className="r-meta">{checkLine}</p>}
          <div className="flex flex-wrap gap-3">
            {filtered ? (
              <Key asChild variant="raised">
                <Link href={rolesHref(query, NO_FILTERS)}>Clear filters</Link>
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

      {!failed && query.tab === 'for-you' && query.group === 'ranked' && (
        <>
          {hasModel && uncheckedLine(unchecked) && <p className="r-meta">{uncheckedLine(unchecked)}</p>}
          {!hasModel && !reacted && rest.length > 0 && (
            <div className="space-y-3">
              <p className="r-body">{NO_MODEL_LINE}</p>
              <OpenRouterDoor returnTo="/roles" />
            </div>
          )}
        </>
      )}

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

      {!failed && query.tab === 'for-you' && query.group === 'type' && (
        <div className="space-y-8">
          {typeGroups.map((g) => (
            <section key={g.key} aria-label={g.label} className="space-y-1">
              <h2 className="r-title px-2">{typeGroupHeader(g)}</h2>
              <div className="r-sheet">{g.items.map((i) => line(i))}</div>
              {g.more !== null && g.more > 0 && g.key !== 'none' && (
                <p className="px-2">
                  <Link href={rolesHref(query, { group: 'ranked', roleType: g.key, limit: PAGE })} className="r-body underline underline-offset-4">
                    {g.more} more of this type
                  </Link>
                </p>
              )}
            </section>
          ))}
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
        <div className="space-y-6">
          {ordered.length === 0 ? (
            <p className="r-body">Nothing hidden.</p>
          ) : (
            <>
              {ordered.some((i) => i.hiddenReason !== 'unclassified') && (
                <div className="r-sheet">
                  {ordered
                    .filter((i) => i.hiddenReason !== 'unclassified')
                    .map((i) => (
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
              {ordered.some((i) => i.hiddenReason === 'unclassified') && (
                <details className="space-y-2">
                  <summary className="r-title cursor-pointer px-2">Cello could not tell the role type of these, {untypedTotal}</summary>
                  <div className="r-sheet">
                    {ordered
                      .filter((i) => i.hiddenReason === 'unclassified')
                      .map((i) => (
                        <div key={i.id}>
                          <RoleRow id={i.id} title={i.title} company={i.company} companyId={i.companyId} domain={i.domain} logoUrl={i.logoUrl} meta={metaLine(i, now)} />
                          <ChangeType item={i} options={typeOptions} change={typed.changes[i.id]} now={typed.now} onChange={typed.set} onUndo={typed.clear} onReset={() => router.refresh()} label="Set type" />
                        </div>
                      ))}
                  </div>
                </details>
              )}
            </>
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
