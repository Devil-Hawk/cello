import Link from 'next/link'
import { Key } from '@/components/ui/key'
import { RowApply } from './row-apply'
import { LogoTile, RoleTitle } from '@/components/roles/role-tile'
import { RoleRow } from '@/components/roles/role-row'
import { metaLine, postedAgo } from '@/components/roles/logic'
import { companyHref } from '@/lib/routes/companies'
import type { CompanyData, LiveData, LiveItem } from '@/app/(app)/companies/[id]/read'
import {
  RATE_LINE,
  RENDERED_LINE,
  cannotReadSite,
  companyPageHref,
  countedLine,
  failureLine,
  headlineLine,
  keptOnlyLine,
  noMatchLine,
  previewHref,
  windowLine,
  type CompanyQuery,
} from './company-logic'

export interface OpenRolesProps {
  company: Pick<CompanyData, 'id' | 'name' | 'domain' | 'logoUrl' | 'careersUrl' | 'cannotRead' | 'typeOptions'>
  query: CompanyQuery
  live: LiveData
  now?: number
}

const meta = (i: LiveItem, now: number) => [i.type, i.level, i.location, postedAgo(i.postedAt, now)].filter(Boolean).join(' · ')

/** A role in the employer's list: the title and the company at one weight (the role title rule), the facts, and why Cello did not keep it. A kept title opens its record; any other opens its preview. */
function LiveRow({ item, company, query, now }: { item: LiveItem; company: OpenRolesProps['company']; query: CompanyQuery; now: number }) {
  return (
    <div className="r-row flex flex-wrap items-start gap-x-3 gap-y-2 px-2 py-3">
      <LogoTile name={company.name} domain={company.domain} logoUrl={company.logoUrl} companyId={company.id} size={40} />
      <div className="min-w-0 flex-1 basis-48">
        {item.jobId ? (
          <RoleTitle id={item.jobId} title={item.title} company={company.name} companyId={company.id} />
        ) : (
          <span className="flex min-w-0 flex-col">
            <Link href={previewHref(company.id, item.key, query)} prefetch={false} className="r-name hover:underline">
              {item.title}
            </Link>
            <Link href={companyHref(company.id)} prefetch={false} className="r-name hover:underline">
              {company.name}
            </Link>
          </span>
        )}
        <p className="r-meta mt-1">{meta(item, now) || null}</p>
        {item.reason ? <p className="r-meta">{item.reason}</p> : <p className="r-meta">Kept for you</p>}
      </div>
      <RowApply jobId={item.jobId ?? null} employerId={company.id} postingKey={item.key} title={item.title} />
    </div>
  )
}

/** The roles Cello kept before, shown when the site cannot be read now. */
function KeptBefore({ live, now }: { live: LiveData; now: number }) {
  if (live.keptBefore.length === 0) return null
  return (
    <div className="r-sheet">
      {live.keptBefore.map((i) => (
        <RoleRow key={i.id} id={i.id} title={i.title} company={i.company} companyId={i.companyId} domain={i.domain} logoUrl={i.logoUrl} meta={metaLine(i, now)} />
      ))}
    </div>
  )
}

function OpenSite({ href }: { href: string | null }) {
  if (!href) return null
  return (
    <Key asChild variant="raised">
      <a href={href} target="_blank" rel="noopener noreferrer">
        Open their careers site
      </a>
    </Key>
  )
}

// The whole list (kept roles first, then the rest, 25 a page) or the search in it. Every state is honest: a site
// that cannot be read says why and shows what was kept before, never "0 open"; one read only in the background
// says so; a word that matches nothing says so. The counted line adds up to what the employer listed.
export function OpenRoles({ company, query, live, now = Date.now() }: OpenRolesProps) {
  const site = company.careersUrl ?? (company.domain ? `https://${company.domain}` : null)
  const searching = query.q !== null

  if (live.rendered)
    return (
      <div className="space-y-3">
        <p className="r-body">{RENDERED_LINE}</p>
        <OpenSite href={site} />
      </div>
    )
  if (live.limited) return <p className="r-body">{RATE_LINE}</p>
  if (company.cannotRead)
    return (
      <div className="space-y-3">
        <p className="r-body">{cannotReadSite(company.name, company.cannotRead)}</p>
        {searching && <p className="r-meta">{keptOnlyLine(company.name)}</p>}
        <KeptBefore live={live} now={now} />
        {searching && live.keptBefore.length === 0 && <p className="r-body">{noMatchLine(company.name, query.q!)}</p>}
        <OpenSite href={site} />
      </div>
    )
  if (live.total === 0)
    return (
      <div className="space-y-3">
        <p className="r-body">{failureLine(company.name, live.failure)}</p>
        <KeptBefore live={live} now={now} />
        <OpenSite href={site} />
      </div>
    )

  const line = countedLine(live)
  const shown = live.page * 25
  return (
    <div className="space-y-4">
      {!searching && <p className="r-body">{headlineLine(live.total, live.kept)}</p>}
      {live.window && <p className="r-meta">{windowLine(live.total)}</p>}

      <form action={companyHref(company.id)} method="get" className="flex flex-wrap items-end gap-3">
        {query.q && <input type="hidden" name="q" value={query.q} />}
        {!query.q && <input type="hidden" name="all" value="1" />}
        <label className="block space-y-1.5">
          <span className="r-meta">Role type</span>
          <select name="type" defaultValue={query.type ?? ''} className="r-field">
            <option value="">Any type</option>
            {company.typeOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="r-meta">Place</span>
          <input name="place" defaultValue={query.place ?? ''} maxLength={60} className="r-field" placeholder="Remote, Paris" />
        </label>
        <Key type="submit" variant="raised">
          Filter
        </Key>
        {(query.type || query.place) && (
          <Key asChild variant="ghost">
            <Link href={companyPageHref(company.id, query, { type: null, place: null, page: 0 })}>Clear</Link>
          </Key>
        )}
      </form>

      {live.matched === 0 ? (
        <p className="r-body">{searching ? noMatchLine(company.name, query.q!) : 'No open role matches these filters.'}</p>
      ) : (
        <div className="r-sheet">
          {live.items.map((i) => (
            <LiveRow key={i.key} item={i} company={company} query={query} now={now} />
          ))}
        </div>
      )}

      {line && <p className="r-meta">{line}</p>}

      {live.matched > 0 && live.pages > 1 && (
        <nav aria-label="Pages" className="flex flex-wrap items-center gap-3">
          {live.page > 0 && (
            <Key asChild variant="ghost">
              <Link href={companyPageHref(company.id, query, { page: live.page - 1 })}>Previous</Link>
            </Key>
          )}
          <span className="r-meta">{`Page ${live.page + 1} of ${live.pages}, roles ${shown + 1} to ${Math.min(shown + 25, live.matched)} of ${live.matched.toLocaleString('en-US')}`}</span>
          {live.page + 1 < live.pages && (
            <Key asChild variant="raised">
              <Link href={companyPageHref(company.id, query, { page: live.page + 1 })}>Next</Link>
            </Key>
          )}
        </nav>
      )}
    </div>
  )
}
