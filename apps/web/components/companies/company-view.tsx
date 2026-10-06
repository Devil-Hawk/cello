import Link from 'next/link'
import { Key } from '@/components/ui/key'
import { search } from '@/lib/routes'
import { Disclosure } from '@/components/ui/disclosure'
import { QuickChatSlot } from '@/components/layout/quick-chat-slot'
import { ContactNetworkPanel } from '@/components/contacts/contact-network-panel'
import { LogoTile } from '@/components/roles/role-tile'
import { RoleRow } from '@/components/roles/role-row'
import { chanceWord, metaLine } from '@/components/roles/logic'
import type { CompanyData, LiveData } from '@/app/(app)/companies/[id]/read'
import { AddOrFind } from './add-or-find'
import { DossierPanel } from './dossier-panel'
import { OpenRoles } from './open-roles'
import { RemoveCompany } from './remove-company'
import { RowActions } from './row-actions'
import { FOLLOW_LEARN, cannotReadSite, checksLine, companyPageHref, emailLine, fieldLines, headlineLine, type CompanyQuery } from './company-logic'

export interface CompanyViewProps {
  data: CompanyData
  query: CompanyQuery
  /** The live list, when the address asks for it (the whole list, or a search). */
  live: LiveData | null
  now?: number
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

// Company: a calm first screen (who, whether there is a role for the person, what is kept, one place to search),
// then groups that open in place, each hidden when it has nothing to say. Nothing on it is a summary without its
// source, and the open-role total is never the headline: the roles kept for the person are.
export function CompanyView({ data, query, live, now = Date.now() }: CompanyViewProps) {
  const open = data.state === 'directory'
  const site = data.careersUrl ?? (data.domain ? `https://${data.domain}` : null)
  const checks = checksLine({ following: data.following, lastReadAt: data.lastReadAt, check: data.check }, now)
  const searching = query.q !== null
  const listOpen = open && (searching || query.all)
  const lines = data.field ? fieldLines(data.field, data.name) : []

  return (
    <article className="mx-auto max-w-[900px] space-y-8 pb-20">
      <header className="space-y-4">
        <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
          <LogoTile name={data.name} domain={data.domain} logoUrl={data.logoUrl} size={80} state={data.cannotRead ? 'flat' : 'default'} />
          <div className="min-w-0 flex-1 basis-56 space-y-1">
            <h1 className="r-display">{data.name}</h1>
            {data.domain && (
              <p className="r-meta">
                <a href={`https://${data.domain}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                  {data.domain}
                </a>
              </p>
            )}
          </div>
        </div>

        {open && (
          <>
            <RowActions item={{ id: data.id, companyId: data.companyId, name: data.name, following: data.following, pinned: data.pinned, cannotRead: data.cannotRead }} manage />
            {!data.following && <p className="r-meta">Follow reads its site every 6 hours.</p>}
            {!data.following && (
              <details>
                <summary className="r-meta cursor-pointer underline underline-offset-4">Learn more</summary>
                <p className="r-body mt-2">{FOLLOW_LEARN}</p>
              </details>
            )}
          </>
        )}

        {data.cannotRead ? (
          <p className="r-body">
            {cannotReadSite(data.name, data.cannotRead)}{' '}
            {site && (
              <a href={site} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                Open their careers site
              </a>
            )}
          </p>
        ) : (
          checks && <p className="r-meta">{checks}</p>
        )}

        {open && (
          <form action={`/companies/${data.id}`} method="get" role="search" className="flex flex-wrap items-center gap-2">
            <label className="min-w-0 flex-1 basis-56">
              <span className="sr-only">{`Search ${data.name}'s roles`}</span>
              <input name="q" defaultValue={query.q ?? ''} maxLength={80} placeholder={`Search ${data.name}'s roles`} className="r-field w-full" />
            </label>
            <Key type="submit" variant="raised">
              Search
            </Key>
            {searching && (
              <Key asChild variant="ghost">
                <Link href={companyPageHref(data.id, query, { q: null, page: 0 })}>Clear</Link>
              </Key>
            )}
          </form>
        )}
      </header>

      {!open && (
        <section className="space-y-4" aria-labelledby="email">
          <h2 id="email" className="sr-only">
            Its job site
          </h2>
          <p className="r-body">{emailLine(data.appliedAt)}</p>
          <p className="r-meta">Add its careers page to follow it and see its roles.</p>
          <AddOrFind />
        </section>
      )}

      {open && !listOpen && (
        <section aria-labelledby="kept" className="space-y-3">
          <h2 id="kept" className="r-title px-2">
            {data.forYou > 0 ? `Kept for you, ${data.forYou}` : 'Kept for you'}
          </h2>
          {data.kept.length > 0 ? (
            <div className="r-sheet">
              {data.kept.map((i) => (
                <RoleRow
                  key={i.id}
                  id={i.id}
                  title={i.title}
                  company={i.company}
                  companyId={i.companyId}
                  domain={i.domain}
                  logoUrl={i.logoUrl}
                  meta={
                    <>
                      {metaLine(i, now)}
                      {chanceWord(i.chance) && <span className="ml-2 text-r-ink-2">{chanceWord(i.chance)}</span>}
                    </>
                  }
                />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="r-body">{data.cannotRead ? 'No role is kept for you here yet.' : `${data.name} has no role kept for you right now.`}</p>
              <div className="flex flex-wrap gap-2">
                {site && (
                  <Key asChild variant="raised">
                    <a href={site} target="_blank" rel="noopener noreferrer">
                      Open their careers site
                    </a>
                  </Key>
                )}
                <Key asChild variant="raised">
                  <Link href={search.href}>Edit your search</Link>
                </Key>
              </div>
            </div>
          )}
          {!data.cannotRead && data.tier !== 'rendered' && (
            <p className="px-2">
              <Link href={companyPageHref(data.id, query, { all: true, page: 0 })} className="r-body underline underline-offset-4">
                {data.open !== null ? `${headlineLine(data.open, data.forYou)} Show all open roles` : 'Show all open roles'}
              </Link>
            </p>
          )}
        </section>
      )}

      {listOpen && (
        <section aria-labelledby="list" className="space-y-3">
          <h2 id="list" className="r-title px-2">
            {searching ? 'Search results' : 'All open roles'}
          </h2>
          {live && <OpenRoles company={{ id: data.id, name: data.name, domain: data.domain, logoUrl: data.logoUrl, careersUrl: data.careersUrl, cannotRead: data.cannotRead, typeOptions: data.typeOptions }} query={query} live={live} now={now} />}
          <p className="px-2">
            <Link href={companyPageHref(data.id, { ...query, q: null, all: false, type: null, place: null, page: 0 })} className="r-meta underline underline-offset-4">
              {`Back to ${data.name}`}
            </Link>
          </p>
        </section>
      )}

      {open && <QuickChatSlot about={{ kind: 'company', ref: data.id }} />}

      {open && !listOpen && (
        <div className="r-sheet-lead">
          {lines.length > 0 && (
            <Disclosure title="Hiring in your field">
              <ul className="r-body space-y-2">
                {lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {data.field && data.field.byType.length > 0 && (
                <p className="mt-3">
                  <Link href={companyPageHref(data.id, query, { all: true, type: data.field.byType[0].id, page: 0 })} className="r-body underline underline-offset-4">
                    Show them
                  </Link>
                </p>
              )}
            </Disclosure>
          )}

          {data.companyId && (
            <Disclosure title="People">
              <ContactNetworkPanel companyId={data.companyId} variant="plain" />
            </Disclosure>
          )}

          {data.history.length > 0 && (
            <Disclosure title={`Your history with ${data.name}`} count={data.history.length}>
              <ol className="r-body space-y-3">
                {data.history.slice(0, 20).map((h) => (
                  <li key={`${h.at}${h.text}`}>
                    <span className="r-meta block">{day(h.at)}</span>
                    {h.text}
                  </li>
                ))}
              </ol>
            </Disclosure>
          )}

          {(data.facts.length > 0 || data.companyId) && (
            <Disclosure title="What Cello knows">
              <ul className="r-body space-y-3">
                {data.facts.map((f) => (
                  <li key={f.text}>
                    {f.text}
                    <span className="r-meta block">{f.source}</span>
                  </li>
                ))}
              </ul>
              {data.companyId && (
                <details className="mt-4">
                  <summary className="r-body cursor-pointer underline underline-offset-4">Research</summary>
                  <div className="mt-3">
                    <DossierPanel companyId={data.companyId} />
                  </div>
                </details>
              )}
            </Disclosure>
          )}

          {data.notes && (
            <Disclosure title="Your notes">
              <p className="r-body whitespace-pre-wrap">{data.notes}</p>
            </Disclosure>
          )}

          {checks && (
            <Disclosure title="Checks">
              <p className="r-body">{checks}</p>
            </Disclosure>
          )}
        </div>
      )}

      {data.companyId && data.remove && <RemoveCompany companyId={data.companyId} name={data.name} counts={data.remove} />}
    </article>
  )
}
