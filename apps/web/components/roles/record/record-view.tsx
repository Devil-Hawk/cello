import Link from 'next/link'
import { Disclosure } from '@/components/ui/disclosure'
import { companyHref } from '@/lib/routes/companies'
import { afterGroups } from '../after'
import { Key } from '@/components/ui/key'
import { LogoTile } from '../role-tile'
import type { RoleItem } from '../types'
import { RecordHead } from './head'
import { Posting } from './posting'

export interface RecordPerson {
  id: string
  name: string
  title: string | null
  /** How the person knows them or where the name came from. */
  how: string | null
}

export interface RecordHistoryItem {
  at: string
  text: string
}

export interface RecordData {
  role: RoleItem
  /** The employer's own page for the posting. */
  url: string | null
  description: string
  /** The reader's tier for this posting, and when it was last confirmed listed. */
  tier: string | null
  checkedAt: string | null
  /** The employer's words about place, as stated. */
  place: string | null
  /** Parsed facts that add something: remote, country. */
  remote: boolean | null
  status: string | null
  why: string | null
  sponsorship: string[]
  employer: { open: number | null; forYou: number | null }
  people: RecordPerson[]
  history: RecordHistoryItem[]
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

// The record: a calm first screen, then groups that open in place, each hidden
// when it has nothing to say. The posting is the whole of what the employer wrote;
// nothing here is a summary of it. The groups for acting on a role (Application,
// Documents, Messages) are mounted from after/ once they ship.
export function RecordView({ data }: { data: RecordData }) {
  const { role } = data
  return (
    <article className="mx-auto max-w-[860px] space-y-10 pb-20">
      <RecordHead role={role} url={data.url} status={data.status} />

      <div className="r-sheet-lead">
        {afterGroups.map((Group, i) => (
          <Group key={i} jobId={role.id} />
        ))}

        <Disclosure title="The posting" defaultOpen>
          <Posting text={data.description} company={role.company} url={data.url} tier={data.tier} closed={role.closed} checkedAt={data.checkedAt} />
        </Disclosure>

        <Disclosure title="Pay and place">
          <dl className="r-body space-y-3">
            <div>
              <dt className="r-meta">Pay</dt>
              <dd>{role.pay ?? 'The posting does not state pay.'}</dd>
            </div>
            <div>
              <dt className="r-meta">Place</dt>
              <dd>{[data.place, data.remote ? 'Remote' : null].filter(Boolean).join(', ') || 'The posting does not state a place.'}</dd>
            </div>
            {data.sponsorship.map((l) => (
              <div key={l}>
                <dt className="sr-only">Sponsorship</dt>
                <dd>{l}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>

        {data.why && (
          <Disclosure title="Why this role">
            <p className="r-body">{data.why}</p>
          </Disclosure>
        )}

        <Disclosure title="The company">
          <div className="flex items-start gap-3">
            <LogoTile name={role.company} domain={role.domain} logoUrl={role.logoUrl} companyId={role.companyId} size={48} />
            <div className="space-y-1">
              {role.companyId ? (
                <Link href={companyHref(role.companyId)} className="r-name hover:underline">
                  {role.company}
                </Link>
              ) : (
                <span className="r-name">{role.company}</span>
              )}
              {role.domain && <p className="r-meta">{role.domain}</p>}
              {data.employer.forYou !== null && (
                <p className="r-body">
                  {data.employer.open !== null ? `${data.employer.open} open, ${data.employer.forYou} for you` : `${data.employer.forYou} for you`}
                </p>
              )}
            </div>
          </div>
          {role.companyId && (
            <Key asChild variant="raised" className="mt-4">
              <Link href={companyHref(role.companyId)}>Open {role.company}</Link>
            </Key>
          )}
        </Disclosure>

        {data.people.length > 0 && (
          <Disclosure title="People there" count={data.people.length}>
            <ul className="r-body space-y-3">
              {data.people.map((p) => (
                <li key={p.id}>
                  <span className="r-name">{p.name}</span>
                  <span className="r-meta block">{[p.title, p.how].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}

        {data.history.length > 0 && (
          <Disclosure title={`Your history with ${role.company}`} count={data.history.length}>
            <ol className="r-body space-y-3">
              {data.history.map((h) => (
                <li key={`${h.at}${h.text}`}>
                  <span className="r-meta block">{day(h.at)}</span>
                  {h.text}
                </li>
              ))}
            </ol>
          </Disclosure>
        )}
      </div>
    </article>
  )
}
