import Link from 'next/link'
import { WorkingMark } from '@/components/depth/working-mark'
import { metaLine } from '@/components/roles/logic'
import { RoleRow } from '@/components/roles/role-row'
import type { PickItem, RoleItem } from '@/components/roles/types'
import { OpenRouterDoor } from '@/components/settings/openrouter-door'
import type { NeedsYouRow } from '@/lib/needs-you/types'
import { Key } from '@/components/ui/key'
import { roles, search } from '@/lib/routes'
import { FAILED, FIRST_USE, headerSentence, keptSince, needsYouCount, quietSentence, sentLine, type SentRow, type SinceChange } from './logic'
import { NeedsYou } from './needs-you'

export interface TodayData {
  /** failed: the reads did not come back. first: nothing has been read for this person yet. */
  state: 'ready' | 'first' | 'failed'
  /** Today's band: the day's picks, or while picks are off the newest kept roles, in code order. */
  band: { kind: 'picks' | 'newest'; items: Array<RoleItem | PickItem> }
  /** Roles that became visible today, counted in SQL. */
  newCount: number
  /** From the clock's record only; null when the clock has said nothing. */
  check: string | null
  /** A role check is running now. */
  working: boolean
  /** Null on a first visit, when there is no earlier visit to measure from. */
  since: { kept: number; changes: SinceChange[] } | null
  /** Applications sent in the last 14 days. */
  sent: SentRow[]
  /** Gmail is connected with read access, so replies can be seen. */
  canReadReplies: boolean
  /** The person has a model, so Cello can rank roles. */
  hasModel: boolean
  /** What waits on the person, from K20's list (lib/today/needs-you.stub.ts until it is on main). */
  needs: NeedsYouRow[]
  now: number
}

const SHOWN = 3

// Today: what changed and is Cello working. One header sentence, the picks row,
// the check line from the clock, Working now, Since you were last here, and the
// quiet state. Needs you joins above the picks once its rows exist. Every row with
// a role is the shared row, so the title is at the company's weight and opens the record.
export function TodayView({ data }: { data: TodayData }) {
  if (data.state === 'failed') {
    return (
      <div className="mx-auto max-w-[860px] space-y-4 pb-16">
        <h1 className="r-display">Today</h1>
        <p role="alert" className="r-body">
          {FAILED}{' '}
          <Link href="/today" className="underline underline-offset-4">
            Try again
          </Link>
        </p>
      </div>
    )
  }

  const { band } = data
  const shown = band.items.slice(0, SHOWN)
  const header = data.state === 'first' ? 'Welcome.' : headerSentence({ needs: needsYouCount(data.needs), band: { kind: band.kind, count: band.items.length }, newCount: data.newCount })
  const kept = data.since ? keptSince(data.since.kept) : null

  return (
    <div className="mx-auto max-w-[860px] space-y-10 pb-16">
      <header className="space-y-2">
        <h1 className="r-display">{header}</h1>
        {data.state === 'first' ? <p className="r-body">{FIRST_USE}</p> : data.check && <p className="r-meta">{data.check}</p>}
      </header>

      <NeedsYou rows={data.needs} />

      {data.working && (
        <section aria-labelledby="working" className="space-y-2">
          <h2 id="working" className="r-title">
            Working now
          </h2>
          <p className="r-body flex items-center gap-3">
            <WorkingMark />
            Checking roles for your search.
          </p>
        </section>
      )}

      {shown.length > 0 && (
        <section aria-labelledby="picks" className="space-y-3">
          <h2 id="picks" className="r-title">
            {band.kind === 'picks' ? 'Picks' : 'Newest roles'}
          </h2>
          <div className="r-sheet-lead">
            {shown.map((i) => (
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
                    {metaLine(i, data.now)}
                    {'explanation' in i && i.explanation && <span className="mt-1 block">{i.explanation}</span>}
                  </>
                }
              />
            ))}
          </div>
          <Key asChild variant="raised">
            <Link href={roles.href}>Open Roles</Link>
          </Key>
        </section>
      )}

      {!data.hasModel && band.kind === 'newest' && shown.length > 0 && (
        <section aria-labelledby="no-model" className="space-y-3">
          <h2 id="no-model" className="sr-only">
            Models
          </h2>
          <p className="r-body">Roles are listed by title and date. Cello can rank them with a free model.</p>
          <OpenRouterDoor returnTo="/today" />
        </section>
      )}

      {data.since && (kept || data.since.changes.length > 0) && (
        <section aria-labelledby="since" className="space-y-3">
          <h2 id="since" className="r-title">
            Since you were last here
          </h2>
          {kept && (
            <p className="r-body">
              {kept}{' '}
              <Link href={roles.href} className="underline underline-offset-4">
                Open Roles
              </Link>
            </p>
          )}
          {data.since.changes.length > 0 && (
            <div className="r-sheet">
              {data.since.changes.map((c) => (
                <RoleRow key={c.jobId} id={c.jobId} title={c.title} company={c.company} companyId={c.companyId} domain={c.domain} logoUrl={c.logoUrl} meta={c.text} />
              ))}
            </div>
          )}
        </section>
      )}

      {data.sent.length > 0 && (
        <section aria-labelledby="sent" className="space-y-3">
          <h2 id="sent" className="r-title">
            {quietSentence(data.sent.length, data.canReadReplies, data.sent.filter((r) => r.stage !== 'applied').length)}
          </h2>
          <div className="r-sheet">
            {data.sent.map((r) => (
              <RoleRow
                key={r.jobId}
                id={r.jobId}
                title={r.title}
                company={r.company}
                companyId={r.companyId}
                domain={r.domain}
                logoUrl={r.logoUrl}
                state={r.closed ? 'flat' : 'default'}
                meta={sentLine(r, data.now)}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <Key asChild variant="raised">
              <Link href={roles.href}>See these roles</Link>
            </Key>
            <Key asChild variant="raised">
              <Link href={search.href}>Widen your search</Link>
            </Key>
          </div>
        </section>
      )}
    </div>
  )
}
