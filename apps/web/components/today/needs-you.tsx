import Link from 'next/link'
import { LogoTile } from '@/components/roles/role-tile'
import { RoleRow } from '@/components/roles/role-row'
import { Key } from '@/components/ui/key'
import { companyHref } from '@/lib/routes/companies'
import { recordHref } from '@/lib/routes/roles'
import type { NeedsYouRow } from '@/lib/needs-you/types'
import { NEEDS_SHOWN, orderNeedsYou } from './logic'

// ponytail: a button whose command is not a route goes to the page of its target until K20's
// command runner is on main; the runner then takes `command` and `args` as they stand.
function buttonHref(row: NeedsYouRow): string {
  if (row.button.command.startsWith('/')) return row.button.command
  if (row.target.kind === 'role') return recordHref(row.target.id)
  if (row.target.kind === 'company') return companyHref(row.target.id)
  return row.target.kind === 'application' ? '/pipeline' : '/today'
}

function NeedsRow({ row }: { row: NeedsYouRow }) {
  const button = (
    <Key asChild>
      <Link href={buttonHref(row)} prefetch={false}>
        {row.button.label}
      </Link>
    </Key>
  )
  // A role the row is about is the shared row: the title at the company's weight, opening the record.
  if (row.target.kind === 'role' && row.roleTitle) {
    return <RoleRow id={row.target.id} title={row.roleTitle} company={row.companyName ?? 'Employer'} companyId={row.companyId} logoUrl={row.logoUrl} meta={row.sentence} actions={button} />
  }
  // ponytail: an application row cannot link its role title to the record until K20's row carries the job id.
  return (
    <div className="r-row flex flex-wrap items-start gap-x-3 gap-y-2 px-2 py-3">
      {row.companyName && <LogoTile name={row.companyName} logoUrl={row.logoUrl} companyId={row.companyId} size={48} />}
      <div className="min-w-0 flex-1 basis-48">
        {row.roleTitle && <span className="r-name block">{row.roleTitle}</span>}
        {row.companyName && (row.companyId ? <Link href={companyHref(row.companyId)} prefetch={false} className="r-name hover:underline">{row.companyName}</Link> : <span className="r-name">{row.companyName}</span>)}
        <p className="r-meta mt-1">{row.sentence}</p>
      </div>
      <div className="flex flex-none flex-wrap items-center gap-2">{button}</div>
    </div>
  )
}

/** What waits on the person, in the order of 4.4: seven rows, then "Show N more". Nothing is drawn for an empty list. */
export function NeedsYou({ rows }: { rows: readonly NeedsYouRow[] }) {
  if (rows.length === 0) return null
  const ordered = orderNeedsYou(rows)
  const first = ordered.slice(0, NEEDS_SHOWN)
  const more = ordered.slice(NEEDS_SHOWN)
  return (
    <section aria-labelledby="needs-you" className="space-y-3">
      <h2 id="needs-you" className="r-title">
        Needs you
      </h2>
      <div className="r-sheet-lead">
        {first.map((r) => (
          <NeedsRow key={r.id} row={r} />
        ))}
      </div>
      {more.length > 0 && (
        <details className="space-y-3">
          <summary className="r-key r-key-raised min-h-11 cursor-pointer list-none font-r">Show {more.length} more</summary>
          <div className="r-sheet">
            {more.map((r) => (
              <NeedsRow key={r.id} row={r} />
            ))}
          </div>
        </details>
      )}
    </section>
  )
}
