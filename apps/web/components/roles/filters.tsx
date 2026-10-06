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

// The filter row: a plain form that sends its fields to the address (GET), so
// every filter is a link someone can share, and it works with no script. Only
// filters that have a column today are here; Language, Chance, Role type and
// Mentions sponsorship join as their columns do.
export function Filters({ query }: { query: RolesQuery }) {
  const n = filterCount(query)
  return (
    <details className="relative">
      <summary className="r-key r-key-raised min-h-11 min-w-11 cursor-pointer list-none font-r">Filters{n > 0 ? ` (${n})` : ''}</summary>
      <form action="/roles" method="get" className="r-sheet-lead absolute left-0 top-full z-30 mt-2 w-[min(92vw,360px)] space-y-4 p-4">
        {query.sort !== 'ranked' && <input type="hidden" name="sort" value={query.sort} />}
        {query.group !== 'ranked' && <input type="hidden" name="group" value={query.group} />}
        {query.company && <input type="hidden" name="company" value={query.company} />}

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
          {(
            [
              ['undated', '1', query.undated, 'Include roles with no posted date'],
              ['remote', '1', query.remote, 'Remote only'],
              ['agency', 'hide', query.hideAgency, 'Hide agency postings and reposts'],
            ] as const
          ).map(([name, value, on, label]) => (
            <label key={name} className="flex min-h-11 items-center gap-3 r-body">
              <input type="checkbox" name={name} value={value} defaultChecked={on} className="h-5 w-5" />
              {label}
            </label>
          ))}
        </fieldset>

        <div className="flex gap-2">
          <Key type="submit">Apply</Key>
          <Key asChild variant="ghost">
            <Link href={rolesHref(query, { level: null, posted: 'any', undated: false, remote: false, country: null, company: null, hideAgency: false })}>Clear</Link>
          </Key>
        </div>
      </form>
    </details>
  )
}
