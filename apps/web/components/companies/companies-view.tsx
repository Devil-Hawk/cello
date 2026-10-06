import Link from 'next/link'
import { Key } from '@/components/ui/key'
import { search } from '@/lib/routes'
import type { CompaniesData } from '@/app/(app)/companies/read'
import { AddOrFind } from './add-or-find'
import { DetailsPanel, DirectoryRow } from './directory-row'
import { FollowingTools } from './following-tools'
import {
  FAILED_LINE,
  FILINGS_LINE,
  FOLLOWING_EMPTY,
  HIRING_EMPTY,
  NO_FILTERS,
  NO_MATCH_LINE,
  NO_TYPES_LINE,
  TABS,
  companiesHref,
  filterCount,
  loadingLine,
  readingLine,
  tabLabel,
  type AddState,
  type CompaniesQuery,
} from './logic'
import { Suggestions } from './suggestions'

export type CompaniesViewProps = CompaniesData & { query: CompaniesQuery; now?: number; add?: AddState }

// The filter form is a plain GET form: every filter is in the address, so it can be shared and Back keeps it.
function Filters({ query, typeOptions, needsSponsorship }: Pick<CompaniesViewProps, 'query' | 'typeOptions' | 'needsSponsorship'>) {
  const n = filterCount(query)
  const checks: Array<[string, boolean, string]> = [
    ['cannot', query.cannot, 'Cannot read'],
    ['pinned', query.pinned, 'Pinned only'],
  ]
  if (needsSponsorship) checks.push(['h1b', query.h1b, FILINGS_LINE])
  return (
    <details className="relative">
      <summary className="r-key r-key-raised min-h-11 min-w-11 cursor-pointer list-none font-r">Filters{n > 0 ? ` (${n})` : ''}</summary>
      <form action="/companies" method="get" className="r-sheet-lead absolute left-0 top-full z-30 mt-2 max-h-[80vh] w-[min(92vw,360px)] space-y-4 overflow-y-auto p-4">
        {query.tab !== 'hiring' && <input type="hidden" name="tab" value={query.tab} />}
        <label className="block space-y-1.5">
          <span className="r-meta">Role type</span>
          <select name="type" defaultValue={query.type ?? ''} className="r-field">
            <option value="">Any type</option>
            {typeOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-1">
          <legend className="sr-only">More</legend>
          {checks.map(([name, on, label]) => (
            <label key={name} className="r-body flex min-h-11 items-center gap-3">
              <input type="checkbox" name={name} value="1" defaultChecked={on} className="h-5 w-5" />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="flex gap-2">
          <Key type="submit">Apply</Key>
          <Key asChild variant="ghost">
            <Link href={companiesHref(query, NO_FILTERS)}>Clear</Link>
          </Key>
        </div>
      </form>
    </details>
  )
}

// Companies: every employer Cello has verified, in three tabs, 50 a page by key. Following changes how often an
// employer is read, never whether it is shown. The address is the whole state (tab, filters, page, the open row).
export function CompaniesView({ query, items, next, counts, loading, check, needsSponsorship, hasTypes, typeOptions, suggestions, details, failed, now = Date.now(), add }: CompaniesViewProps) {
  const filtered = filterCount(query) > 0
  const loadLine = loadingLine(loading.verified, loading.pending)
  const open = query.focus ? items.find((i) => i.id === query.focus) : undefined
  const followedCheck = readingLine({ following: true, lastReadAt: null, cannotRead: null }, check, now)

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 pb-16">
      <header>
        <h1 className="r-display">Companies</h1>
      </header>

      <AddOrFind initial={add} />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <nav aria-label="Companies" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <Key key={t} asChild variant="ghost" current={query.tab === t}>
              <Link href={companiesHref(query, { tab: t, after: null, focus: null })}>{tabLabel(t, counts)}</Link>
            </Key>
          ))}
        </nav>
        <Filters query={query} typeOptions={typeOptions} needsSponsorship={needsSponsorship} />
      </div>

      {loadLine && <p className="r-meta">{loadLine}</p>}

      {failed && (
        <p role="alert" className="r-body">
          {FAILED_LINE}{' '}
          <Link href={companiesHref(query)} className="underline underline-offset-4">
            Try again
          </Link>
        </p>
      )}

      {!failed && query.tab === 'following' && (
        <div className="space-y-6">
          <FollowingTools canCheck={items.length > 0} />
        </div>
      )}

      {!failed && items.length === 0 && (
        <div className="space-y-4">
          {filtered ? (
            <>
              <p className="r-body">{NO_MATCH_LINE}</p>
              <Key asChild variant="raised">
                <Link href={companiesHref(query, NO_FILTERS)}>Clear filters</Link>
              </Key>
            </>
          ) : query.tab === 'hiring' ? (
            <>
              <p className="r-body">{hasTypes ? HIRING_EMPTY : NO_TYPES_LINE}</p>
              {hasTypes && followedCheck && <p className="r-meta">{followedCheck}</p>}
              <div className="flex flex-wrap gap-3">
                <Key asChild variant="raised">
                  <Link href={search.href}>{hasTypes ? 'Edit your search' : 'Choose'}</Link>
                </Key>
                <Key asChild variant="raised">
                  <Link href={companiesHref(query, { tab: 'all', after: null })}>See all companies</Link>
                </Key>
              </div>
            </>
          ) : query.tab === 'following' ? (
            <p className="r-body">{FOLLOWING_EMPTY}</p>
          ) : (
            <p className="r-body">{loadLine ?? 'Cello has not verified an employer yet.'}</p>
          )}
        </div>
      )}

      {!failed && items.length > 0 && (
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-8">
          <div className="r-sheet">
            {items.map((i) => (
              <DirectoryRow
                key={i.id}
                item={i}
                manage={query.tab === 'following'}
                check={check}
                now={now}
                detailsHref={companiesHref(query, { focus: query.focus === i.id ? null : i.id })}
                open={query.focus === i.id}
                details={query.focus === i.id ? details : null}
              />
            ))}
          </div>
          {open && (
            <aside className="r-sheet-lead sticky top-24 hidden lg:block" aria-label="Details">
              <h2 className="r-title px-2 pt-2">{open.name}</h2>
              <DetailsPanel item={open} details={details} now={now} />
            </aside>
          )}
        </div>
      )}

      {!failed && (next || query.after) && (
        <div className="flex flex-wrap gap-3">
          {query.after && (
            <Key asChild variant="ghost">
              <Link href={companiesHref(query, { after: null, focus: null })}>First page</Link>
            </Key>
          )}
          {next && (
            <Key asChild variant="raised">
              <Link href={companiesHref(query, { after: next, focus: null })}>Next</Link>
            </Key>
          )}
        </div>
      )}

      {!failed && query.tab === 'following' && <Suggestions items={suggestions} />}
    </div>
  )
}
