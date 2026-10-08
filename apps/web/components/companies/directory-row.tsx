import Link from 'next/link'
import { Key } from '@/components/ui/key'
import { LogoTile, RoleTitle } from '@/components/roles/role-tile'
import { postedAgo } from '@/components/roles/logic'
import { companyHref } from '@/lib/routes/companies'
import { cannotReadLine, FILINGS_LINE, forYouLine, readingLine, type CheckFacts, type CompanyItem, type Details } from './logic'
import { RowActions } from './row-actions'

const siteOf = (i: Pick<CompanyItem, 'careersUrl' | 'domain'>) => i.careersUrl ?? (i.domain ? `https://${i.domain}` : null)

export interface DirectoryRowProps {
  item: CompanyItem
  /** Following offers Check now and Stop following on the row. */
  manage?: boolean
  check: CheckFacts | null
  now: number
  /** The address that opens or closes this row's details. */
  detailsHref: string
  open: boolean
  /** The details, when the row is open. */
  details?: Details | null
}

/** The roles for the person at one employer: up to five, each title as visible as the company and opening its record. */
export function DetailsPanel({ item, details, now }: { item: CompanyItem; details: Details | null | undefined; now: number }) {
  const site = siteOf(item)
  return (
    <div role="region" className="space-y-3 px-2 pb-3" aria-label={`${item.name}, roles for you`}>
      {details && details.roles.length > 0 ? (
        <ul className="space-y-3">
          {details.roles.map((r) => (
            <li key={r.id}>
              <RoleTitle id={r.id} title={r.title} company={item.name} companyId={item.id} />
              <p className="r-meta">{[r.type, postedAgo(r.postedAt, now)].filter(Boolean).join(' · ') || null}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="r-body">{item.cannotRead ? 'No role kept for you here yet.' : 'No role kept for you here right now.'}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {item.forYou !== null && item.forYou > 0 && (
          <Key asChild variant="raised">
            <Link href={`/roles?group=company&company=${encodeURIComponent(item.id)}`}>See all in Roles</Link>
          </Key>
        )}
        <Key asChild variant="raised">
          <Link href={companyHref(item.id)}>{`Open ${item.name}`}</Link>
        </Key>
        {site && (
          <Key asChild variant="ghost">
            <a href={site} target="_blank" rel="noopener noreferrer">
              Open their careers site
            </a>
          </Key>
        )}
      </div>
    </div>
  )
}

// One employer: its logo and name lead, then what Cello holds for the person there. A count is never shown for a
// site that cannot be read, and the filings line is the public list or nothing.
export function DirectoryRow({ item, manage, check, now, detailsHref, open, details }: DirectoryRowProps) {
  const line = forYouLine(item)
  const reading = readingLine(item, check, now)
  const site = siteOf(item)
  return (
    <div>
      <div className="r-row flex flex-wrap items-start gap-x-3 gap-y-2 px-2 py-3">
        <LogoTile name={item.name} domain={item.domain} logoUrl={item.logoUrl} companyId={item.id} size={48} state={item.cannotRead ? 'flat' : 'default'} />
        <div className="min-w-0 flex-1 basis-48">
          <Link href={companyHref(item.id)} prefetch={false} className="r-name inline-flex min-h-11 items-center hover:underline">
            {item.name}
          </Link>
          {item.domain && <p className="r-meta">{item.domain}</p>}
          {item.cannotRead ? (
            <p className="r-body mt-1">
              {cannotReadLine(item.cannotRead)}
              {site && (
                <>
                  {' '}
                  <a href={site} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                    Open their site
                  </a>
                </>
              )}
            </p>
          ) : (
            line && (
              <p className="r-body mt-1">
                <span className="font-medium">{line.head}</span>
                {line.split && <span className="text-r-ink-2">{`, ${line.split}`}</span>}
                {line.open && <span className="text-r-ink-2">{` ${line.open}`}</span>}
              </p>
            )
          )}
          {reading && <p className="r-meta">{reading}</p>}
          {item.filings && <p className="r-meta">{FILINGS_LINE}</p>}
          <p>
            <Link href={detailsHref} scroll={false} className="r-meta inline-flex min-h-11 min-w-11 items-center underline underline-offset-4">
              {open ? 'Hide details' : 'Details'}
            </Link>
          </p>
        </div>
        <RowActions item={item} manage={manage} />
      </div>
      {open && (
        <div className="lg:hidden">
          <DetailsPanel item={item} details={details} now={now} />
        </div>
      )}
    </div>
  )
}
