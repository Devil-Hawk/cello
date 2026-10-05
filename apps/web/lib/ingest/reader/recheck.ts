// A role that has left a site must stop being shown as open.
//
// Roles read through a window onto a site (its own search, a few listing pages)
// are never counted as missed when a later read does not list them, because the
// window may simply not reach them. So the scheduled pass asks the role's own
// page, a few at a time, oldest sighting first, through the same site fetcher
// (robots.txt, budget, delay): a page that is gone (404 or 410), or that says
// it is closed (validThrough in the past), closes the role. Anything else, an
// error, a robots rule, a spent budget, leaves it as it was.

import type { AtsStore, ExistingJob } from '../../ats/index'
import { readDetail } from './detail'
import { ReaderError, type SiteFetcher } from './site-fetch'

/** Role pages asked per company per scheduled pass: the budget decides how fast a big list is covered. */
export const RECHECK_PER_PASS = 20

export interface Recheck {
  asked: number
  closed: number
}

export async function recheckStoredRoles(
  store: Pick<AtsStore, 'updateJobs'>,
  companyId: string,
  stored: Map<string, ExistingJob>,
  f: SiteFetcher,
  opts: { sources: string[]; seen: ReadonlySet<string>; limit?: number; now?: number }
): Promise<Recheck> {
  const now = opts.now ?? Date.now()
  const due = [...stored.values()]
    .filter((j) => j.open !== false && j.url && !opts.seen.has(j.externalId) && j.source != null && opts.sources.includes(j.source))
    .sort((a, b) => (a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0) - (b.lastSeenAt ? Date.parse(b.lastSeenAt) : 0))
    .slice(0, opts.limit ?? RECHECK_PER_PASS)
  const out: Recheck = { asked: 0, closed: 0 }
  const gone: string[] = []
  for (const job of due) {
    try {
      out.asked++
      const res = await f.get(job.url!)
      if (res.status === 404 || res.status === 410) gone.push(job.externalId)
      else if (res.ok) {
        const until = Date.parse(readDetail(res.text, res.finalUrl).validThrough ?? '')
        if (!Number.isNaN(until) && until < now) gone.push(job.externalId)
      }
    } catch (error) {
      // A spent budget or a bot check ends the re-check; a robots rule or a failed request leaves that role as it was.
      if (error instanceof ReaderError && (error.reason === 'budget' || error.reason === 'bot_check')) break
    }
  }
  if (gone.length > 0) {
    const at = new Date(now).toISOString()
    out.closed = await store.updateJobs(gone.map((externalId) => ({ companyId, externalId, fields: { still_open: false, closed_at: at } })))
  }
  return out
}
