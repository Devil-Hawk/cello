import Link from 'next/link'
import { Key } from '@/components/ui/key'
import { LEVELS, POSTED, POSTED_LABEL, filterCount, rolesHref, type RolesQuery } from './logic'

const LEVEL_LABEL: Record<(typeof LEVELS)[number], string> = {
  intern: 'Intern',
  junior: 'Junior',
  mid: 'Mid',
  senior: 'Senior',
  staff: 'Staff',
  principal: 'Principal',
  manager: 'Manager',
  director: 'Director',
  exec: 'Executive',
}

export interface FiltersProps {
  query: RolesQuery
  /** The types the Role type filter offers. */
  typeOptions: readonly { id: string; label: string }[]
  /** The employers the Company chooser offers. */
  companyOptions: readonly { id: string; label: string }[]
  /** Past H-1B filings is offered to a person who needs sponsorship, and to no one else. */
  needsSponsorship: boolean
}

// The filter row: a plain form that sends its fields to the address (GET), so
// every filter is a link someone can share, and it works with no script. Only
// filters that have a column today are here; Language, Chance and Mentions
// sponsorship join as their columns do.
export function Filters({ query, typeOptions, companyOptions, needsSponsorship }: FiltersProps) {
  const n = filterCount(query)
  const checks: Array<readonly [string, string, boolean, string]> = [
    ['undated', '1', query.undated, 'Include roles with no posted date'],
    ['remote', '1', query.remote, 'Remote only'],
    ['following', '1', query.following, 'Following only'],
    ['agency', 'hide', query.hideAgency, 'Hide agency postings and reposts'],
  ]
  if (needsSponsorship) checks.splice(3, 0, ['h1b', '1', query.h1b, 'Past H-1B filings'])
  return (
    <details className="relative">
      <summary className="r-key r-key-raised min-h-11 min-w-11 cursor-pointer list-none font-r">Filters{n > 0 ? ` (${n})` : ''}</summary>
      <form action="/roles" method="get" className="r-sheet-lead absolute left-0 top-full z-30 mt-2 max-h-[80vh] w-[min(92vw,360px)] space-y-4 overflow-y-auto p-4">
        {query.sort !== 'ranked' && <input type="hidden" name="sort" value={query.sort} />}
        {query.group !== 'ranked' && <input type="hidden" name="group" value={query.group} />}

        <label className="block space-y-1.5">
          <span className="r-meta">Role type</span>
          <select name="type" defaultValue={query.roleType ?? ''} className="r-field">
            <option value="">Any type</option>
            {typeOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="r-meta">Level</span>
          <select name="level" defaultValue={query.level ?? ''} className="r-field">
            <option value="">Any level</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABEL[l]}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="r-meta">Company</span>
          <select name="company" defaultValue={query.company ?? ''} className="r-field">
            <option value="">Any company</option>
            {companyOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="r-meta">Posted</span>
          <select name="posted" defaultValue={query.posted} className="r-field">
            {POSTED.map((p) => (
              <option key={p} value={p}>
                {POSTED_LABEL[p]}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="r-meta">Country, two letters</span>
          <input name="country" defaultValue={query.country ?? ''} maxLength={2} pattern="[A-Za-z]{2}" className="r-field" placeholder="US" />
        </label>

        <fieldset className="space-y-1">
          <legend className="sr-only">More</legend>
          {checks.map(([name, value, on, label]) => (
            <label key={name} className="flex min-h-11 items-center gap-3 r-body">
              <input type="checkbox" name={name} value={value} defaultChecked={on} className="h-5 w-5" />
              {label}
            </label>
          ))}
        </fieldset>

        <div className="flex gap-2">
          <Key type="submit">Apply</Key>
          <Key asChild variant="ghost">
            <Link href={rolesHref(query, { level: null, posted: 'any', undated: false, remote: false, country: null, company: null, roleType: null, following: false, h1b: false, hideAgency: false })}>Clear</Link>
          </Key>
        </div>
      </form>
    </details>
  )
}
